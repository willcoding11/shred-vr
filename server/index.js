// Shred VR dev server: serves the game + editor, stores maps as JSON,
// and relays live edits from the editor to any connected headset/browser.
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import selfsigned from 'selfsigned';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MAPS_DIR = path.join(ROOT, 'maps');
const STATE_FILE = path.join(MAPS_DIR, '_state.json');
const CERT_DIR = path.join(__dirname, 'certs');
const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);

fs.mkdirSync(MAPS_DIR, { recursive: true });

// ---------- map storage ----------
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const mapPath = (id) => path.join(MAPS_DIR, `${id}.json`);

function listMaps() {
  return fs.readdirSync(MAPS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
        const st = fs.statSync(path.join(MAPS_DIR, f));
        return {
          id: m.id, name: m.name, difficulty: m.difficulty || 'green',
          size: m.size, spacing: m.spacing, props: (m.props || []).length,
          order: m.order ?? 100, updatedAt: st.mtimeMs, description: m.description || '',
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
}
function readMap(id) {
  if (!ID_RE.test(id) || !fs.existsSync(mapPath(id))) return null;
  return JSON.parse(fs.readFileSync(mapPath(id), 'utf8'));
}
function writeMap(map) {
  if (!ID_RE.test(map.id)) throw new Error('bad id');
  const tmp = mapPath(map.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map));
  fs.renameSync(tmp, mapPath(map.id));
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ---------- express ----------
const app = express();
app.use(express.json({ limit: '64mb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules/three/build')));
app.use('/vendor/jsm', express.static(path.join(ROOT, 'node_modules/three/examples/jsm')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.get('/api/info', async (req, res) => {
  const ip = lanIp();
  const httpsUrl = `https://${ip}:${HTTPS_PORT}/game/`;
  const httpUrl = `http://${ip}:${HTTP_PORT}/game/`;
  const qr = await QRCode.toDataURL(httpsUrl, { margin: 1, width: 220, color: { dark: '#0b1220', light: '#ffffff' } });
  res.json({ ip, httpPort: HTTP_PORT, httpsPort: HTTPS_PORT, httpsUrl, httpUrl, qr,
    clients: clientCounts(), activeMap: readState().activeMap || null,
    clientList: [...clients].map((c) => ({ role: c.role, ip: c.ip, agent: c.agent,
      mins: +((Date.now() - c.since) / 60000).toFixed(1) })) });
});
app.get('/api/maps', (req, res) => res.json(listMaps()));
app.get('/api/maps/:id', (req, res) => {
  const m = readMap(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(m);
});
app.post('/api/maps', (req, res) => {
  const m = req.body;
  if (!m || !ID_RE.test(m.id || '')) return res.status(400).json({ error: 'bad map' });
  if (fs.existsSync(mapPath(m.id))) return res.status(409).json({ error: 'exists' });
  writeMap(m);
  broadcast({ type: 'maps', maps: listMaps() });
  res.json({ ok: true });
});
// PUT saves and (unless ?quiet=1, used by the editor which already streamed patches) pushes
// the full map to headsets.
function saveHandler(req, res) {
  const m = req.body;
  if (!m || m.id !== req.params.id) return res.status(400).json({ error: 'id mismatch' });
  writeMap(m);
  if (!req.query.quiet) broadcast({ type: 'map', map: m }, (c) => c.role === 'game');
  broadcast({ type: 'maps', maps: listMaps() });
  res.json({ ok: true });
}
app.put('/api/maps/:id', saveHandler);
app.delete('/api/maps/:id', (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  // Move to maps/.trash rather than unlinking: one stray click should not be unrecoverable.
  if (fs.existsSync(mapPath(id))) {
    const trash = path.join(MAPS_DIR, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    try { fs.renameSync(mapPath(id), path.join(trash, `${id}-${Date.now()}.json`)); }
    catch { fs.unlinkSync(mapPath(id)); }
  }
  const st = readState();
  if (st.activeMap === id) {
    st.activeMap = listMaps()[0]?.id || null; writeState(st);
    broadcast({ type: 'active', id: st.activeMap });
  }
  broadcast({ type: 'maps', maps: listMaps() });
  res.json({ ok: true });
});
app.get('/api/state', (req, res) => res.json(readState()));
app.put('/api/state', (req, res) => {
  const st = { ...readState(), ...req.body };
  writeState(st);
  broadcast({ type: 'active', id: st.activeMap });
  res.json(st);
});

// ---------- websocket relay ----------
const clients = new Set();
// A game client on this machine is a desktop preview tab, not a headset. Counting them together
// made the editor report "6 headsets live" when all six were Chrome tabs on localhost and the
// Quest was not connected at all -- which is a badge that lies in the one direction that matters,
// because you trust it to tell you your edits are reaching the thing on your face.
function isHeadset(cl) {
  if (cl.agent === 'Quest browser') return true;
  const ip = cl.ip || '';
  return !(ip === '127.0.0.1' || ip === '::1' || ip === 'localhost');
}
function clientCounts() {
  const c = { game: 0, editor: 0, headset: 0, preview: 0 };
  for (const cl of clients) {
    c[cl.role] = (c[cl.role] || 0) + 1;
    if (cl.role === 'game') c[isHeadset(cl) ? 'headset' : 'preview']++;
  }
  return c;
}
function broadcast(msg, filter = () => true, except = null) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const cl of clients) {
    if (cl === except || !filter(cl)) continue;
    if (cl.ws.readyState === WebSocket.OPEN) cl.ws.send(data);
  }
}
function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    // Who this actually is. "6 headsets live" with no way to see what the six ARE is a number you
    // cannot act on -- the honest answer turned out to be six real pages left open, not six stale
    // sockets, and there was no way to tell those apart from outside.
    const ua = String(req.headers['user-agent'] || '');
    const cl = {
      ws, role: 'unknown', since: Date.now(),
      ip: String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      agent: /OculusBrowser|Quest/i.test(ua) ? 'Quest browser'
        : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'unknown',
    };
    clients.add(cl);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.type) {
        case 'hello':
          cl.role = msg.role === 'editor' ? 'editor' : 'game';
          ws.send(JSON.stringify({ type: 'welcome', active: readState().activeMap || null, maps: listMaps(), counts: clientCounts() }));
          broadcast({ type: 'clients', counts: clientCounts() });
          break;
        case 'patch':      // live terrain brush stroke (region of heights)
        case 'props':      // live prop / marker changes
        case 'env':        // live environment tweaks
          broadcast(raw.toString(), (c) => c.role === 'game');
          break;
        case 'map':        // full map push (also persisted)
          try { writeMap(msg.map); } catch (e) { console.warn('map write failed', e.message); }
          broadcast(raw.toString(), (c) => c.role === 'game');
          broadcast({ type: 'maps', maps: listMaps() }, (c) => c.role === 'editor', cl);
          break;
        case 'active': {
          const st = readState(); st.activeMap = msg.id; writeState(st);
          broadcast({ type: 'active', id: msg.id });
          break;
        }
        case 'telemetry':  // game -> editors (rider position for the live cursor)
          broadcast(raw.toString(), (c) => c.role === 'editor');
          break;
        case 'ping': ws.send('{"type":"pong"}'); break;
      }
    });
    ws.on('pong', () => { cl.alive = true; });
    cl.alive = true;
    ws.on('close', () => { clients.delete(cl); broadcast({ type: 'clients', counts: clientCounts() }); });
  });
}

// Reap half-open sockets so the "N headsets live" count stays honest. This must exist ONCE:
// `attachWs` runs for both the HTTP and HTTPS servers, and two reapers sharing one client set
// would mark a socket dead and terminate it before its pong could arrive.
setInterval(() => {
  for (const cl of clients) {
    // Drop it from the set here as well as in the close handler. terminate() does normally fire
    // 'close', but a socket that is already half-dead may not, and then it counts as live for ever.
    if (cl.alive === false) { try { cl.ws.terminate(); } catch {} clients.delete(cl); continue; }
    cl.alive = false;
    try { cl.ws.ping(); } catch {}
  }
  broadcast({ type: 'clients', counts: clientCounts() });
}, 15000).unref();

// ---------- certs + servers ----------
function lanIp() {
  const ifs = os.networkInterfaces();
  const cands = [];
  for (const [name, list] of Object.entries(ifs)) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const score = /tailscale|vpn|virtual|vEthernet|docker|wsl|hyper/i.test(name) ? 2
      : /wi-?fi|wlan|ethernet|eth/i.test(name) ? 0 : 1;
    cands.push({ score, ip: a.address });
  }
  cands.sort((a, b) => a.score - b.score);
  return cands[0]?.ip || '127.0.0.1';
}
function getCert() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const kp = path.join(CERT_DIR, 'key.pem'), cp = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(kp) && fs.existsSync(cp)) return { key: fs.readFileSync(kp), cert: fs.readFileSync(cp) };
  const ip = lanIp();
  const pems = selfsigned.generate([{ name: 'commonName', value: 'shred-vr.local' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [
      { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip },
    ] }],
  });
  fs.writeFileSync(kp, pems.private); fs.writeFileSync(cp, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

const httpServer = http.createServer(app);
attachWs(httpServer);
httpServer.listen(HTTP_PORT, '0.0.0.0');

let httpsOk = false;
try {
  const httpsServer = https.createServer(getCert(), app);
  attachWs(httpsServer);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0');
  httpsOk = true;
} catch (e) { console.warn('HTTPS disabled:', e.message); }

const ip = lanIp();
console.log([
  '',
  '  Shred VR dev server',
  '  ---------------------------------------------------',
  `  Editor (this PC):   http://localhost:${HTTP_PORT}/editor/`,
  `  Game (desktop):     http://localhost:${HTTP_PORT}/game/`,
  `  Game (headset):     ${httpsOk ? `https://${ip}:${HTTPS_PORT}/game/` : '(https unavailable)'}`,
  `                      or http://localhost:${HTTP_PORT}/game/ after: npm run adb-reverse`,
  `  Maps folder:        ${MAPS_DIR}`,
  '',
].join('\n'));
