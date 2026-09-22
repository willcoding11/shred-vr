// A place for the game to put screenshots.
//
// Reviewing a look by memory does not work: every change to the light or the snow feels like an
// improvement while you are making it, and the only way to know is the same viewpoint before and
// after. The game renders those viewpoints itself (window.shredShots in public/game/main.js) and
// posts them here, because a canvas cannot write to disk and a browser download goes to the wrong
// place with the wrong name.
//
//   npm run shots            # then, in the game's console:  await shredShots()
//
// Files land in renders/shots/<set>/<map>-<view>.jpg, which is what the review reads.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'renders', 'shots');
const PORT = Number(process.env.SHOT_PORT || 8099);

// The game is served from :8080 and this is :8099, so every post is cross-origin.
const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
};

const safe = (s, fallback) => (s || fallback).replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);

http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.end(); return; }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/save') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 40e6) req.destroy(); });
    req.on('end', () => {
      const m = /^data:image\/(\w+);base64,(.*)$/s.exec(body);
      if (!m) { res.statusCode = 400; res.end('expected a data URL'); return; }
      const dir = path.join(OUT, safe(url.searchParams.get('set'), 'latest'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, safe(url.searchParams.get('name'), 'shot') + (m[1] === 'jpeg' ? '.jpg' : '.' + m[1]));
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      process.stdout.write(`  ${path.relative(ROOT, file)}\n`);
      res.end(JSON.stringify({ ok: true, file: path.relative(ROOT, file) }));
    });
    return;
  }
  res.statusCode = 404; res.end('POST /save?set=<name>&name=<name>');
}).listen(PORT, () => console.log(`shots -> ${path.relative(ROOT, OUT)}  (listening on :${PORT})`));
