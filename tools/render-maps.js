// Renders every map in ./maps to a top-down PNG (hillshade + slope tint + props) and
// prints stats JSON. Used by the map critic. Run: npm run render-maps [outDir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { deserializeMap, normalAt, gridToWorld, mapStats, heightAt, PROP_TYPES } from '../public/shared/mapformat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS = path.join(__dirname, '..', 'maps');
const OUT = process.argv[2] || path.join(__dirname, '..', 'renders');
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

function render(map, scale = 2) {
  const { w, h } = map.size, sp = map.spacing;
  const W = w * scale, PROF = 90, H = h * scale + PROF + 10;
  const img = Buffer.alloc(W * H * 3, 20);
  const put = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 3; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; };
  const disc = (cx, cy, r, c) => { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) put(cx + x, cy + y, c); };
  const light = [-0.5, 0.75, -0.45]; const ll = Math.hypot(...light); light[0] /= ll; light[1] /= ll; light[2] /= ll;
  // terrain
  for (let py = 0; py < h * scale; py++) for (let px = 0; px < W; px++) {
    const gx = px / scale, gz = py / scale;
    const [wx, wz] = gridToWorld(map, gx, gz);
    const n = normalAt(map, wx, wz);
    const slope = Math.acos(Math.min(1, n[1])) * 57.3;
    const shade = 0.55 + 0.45 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
    let r = 236, g = 240, b = 248;
    // slope tint bands: 0-10 white, 10-20 light blue, 20-30 blue, 30-40 orange, 40+ red, >50 dark rock
    if (slope > 50) { r = 70; g = 66; b = 62; }
    else if (slope > 40) { r = 230; g = 80; b = 70; }
    else if (slope > 30) { r = 245; g = 160; b = 70; }
    else if (slope > 20) { r = 140; g = 180; b = 245; }
    else if (slope > 10) { r = 195; g = 215; b = 250; }
    put(px, py, [r * shade, g * shade, b * shade]);
  }
  // 100 m grid lines
  for (let z = 0; z * sp < (h - 1) * sp; z += 50) for (let px = 0; px < W; px += 2) put(px, z * scale, [90, 90, 110]);
  for (let gx = 0; gx < w; gx += 25) for (let py = 0; py < h * scale; py += 2) put(gx * scale, py, [90, 90, 110]);
  const toPx = (x, z) => { const [gx, gz] = [x / sp + (w - 1) / 2, z / sp]; return [Math.round(gx * scale), Math.round(gz * scale)]; };
  // props
  for (const p of map.props) {
    const def = PROP_TYPES[p.t]; if (!def) continue;
    const [px, py] = toPx(p.x, p.z);
    let c = hex(def.color), r = 2;
    if (p.t === 'gate') {
      const gw = def.width / sp * scale / 2;
      for (let dx = -gw; dx <= gw; dx++) put(px + Math.round(dx), py, c);
      disc(px - Math.round(gw), py, 2, c); disc(px + Math.round(gw), py, 2, c);
      continue;
    }
    if (p.t === 'boulder' || p.t === 'hut') r = 4;
    if (p.t === 'flag' || p.t === 'lamp' || p.t === 'sign') { c = [255, 200, 40]; r = 2; }
    disc(px, py, r, c);
  }
  // start + finish
  const [sx, sy] = toPx(map.start.x, map.start.z); disc(sx, sy, 5, [0, 220, 90]);
  const [fx, fy] = toPx(map.finish.x, map.finish.z);
  const fw = Math.round(map.finish.w / sp * scale / 2);
  for (let dx = -fw; dx <= fw; dx++) { put(fx + dx, fy, [255, 40, 40]); put(fx + dx, fy + 1, [255, 40, 40]); put(fx + dx, fy - 1, [255, 40, 40]); }
  // centreline elevation profile strip
  const y0 = h * scale + 10;
  let hmax = -1e9, hmin = 1e9;
  const prof = [];
  for (let px = 0; px < W; px++) { const wz = (px / W) * (h - 1) * sp; const y = heightAt(map, 0, wz); prof.push(y); hmax = Math.max(hmax, y); hmin = Math.min(hmin, y); }
  for (let px = 0; px < W; px++) {
    const t = (prof[px] - hmin) / (hmax - hmin + 1e-6);
    const py = y0 + PROF - 4 - Math.round(t * (PROF - 8));
    for (let yy = py; yy < y0 + PROF; yy++) put(px, yy, [120, 170, 255]);
    put(px, py, [255, 255, 255]);
  }
  return encodePNG(W, H, img);
}

const files = fs.readdirSync(MAPS).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const report = {};
for (const f of files) {
  const map = deserializeMap(fs.readFileSync(path.join(MAPS, f), 'utf8'));
  fs.writeFileSync(path.join(OUT, `${map.id}.png`), render(map));
  const s = mapStats(map);
  // centreline grade profile every 50 m for the critic
  const prof = [];
  const { h } = map.size, sp = map.spacing;
  for (let z = 0; z <= (h - 1) * sp; z += 50) {
    const y = heightAt(map, 0, z), y2 = heightAt(map, 0, Math.min((h - 1) * sp, z + 25));
    prof.push({ z, y: +y.toFixed(1), gradeDeg: +((Math.atan2(y - y2, 25) * 180) / Math.PI).toFixed(1) });
  }
  const counts = {};
  for (const p of map.props) counts[p.t] = (counts[p.t] || 0) + 1;
  report[map.id] = { name: map.name, difficulty: map.difficulty, description: map.description, ...s, propCounts: counts, profile: prof,
    start: map.start, finish: map.finish, png: path.join(OUT, `${map.id}.png`) };
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
