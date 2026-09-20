// Reports on a Blender export against what the game actually needs.
// Run: node tools/asset-check.mjs [public/assets/props.glb]
//
// The loader is forgiving -- it re-origins and rescales everything -- so most of what this prints
// is advice rather than errors. The one thing it cannot fix for you is a triangle budget.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalSize } from '../public/shared/propsize.js';

const __d = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__d, '..', 'public', 'assets', 'props.glb');
const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.log('Not a .glb (binary glTF). Export with Format: glTF Binary.'); process.exit(1); }

let off = 12, g = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const slice = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) g = JSON.parse(slice.toString('utf8')); else bin = slice;
  off += 8 + len;
}

// What a prop of each type should measure top to bottom, and what it can afford in triangles.
//
// The budget is per-prop but it is really about how MANY get placed: a tree is drawn five hundred
// times so a thousand triangles is half a million, while a rail is drawn five times so a thousand
// triangles is five thousand and nobody notices. Judge a model by its type's budget, not by its
// own count.
const WANT = {
  pine: [8.4, 600], fir: [10.2, 600], birch: [7, 500],
  rock: [1.2, 300], boulder: [2.8, 450], rail: [0.38, 1600],
  hut: [5.2, 1200], lamp: [3.6, 250], sign: [2.2, 200], snowman: [3.1, 300], fence: [1.3, 250],
};
const TYPES = Object.keys(WANT);
const typeFromName = (n) => {
  const b = String(n).split(/[.\s]/)[0].replace(/_\d+$/, '').toLowerCase();
  return TYPES.includes(b) ? b : null;
};

let manifest = { map: {} };
try { manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'manifest.json'), 'utf8')); } catch {}

function positions(prim) {
  const a = g.accessors[prim.attributes.POSITION], bv = g.bufferViews[a.bufferView];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || 12;
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) {
    const o = start + i * stride;
    out[i * 3] = bin.readFloatLE(o); out[i * 3 + 1] = bin.readFloatLE(o + 4); out[i * 3 + 2] = bin.readFloatLE(o + 8);
  }
  return out;
}
const rot = (q, v) => {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};

console.log(`${path.basename(file)} — ${(buf.length / 1048576).toFixed(2)} MB, ${g.asset.generator}`);
if (g.images?.length) console.log(`  ${g.images.length} texture image(s). The game's prop material is vertex-coloured, so these are ignored.`);
console.log('');
console.log('object                type      size w x h x d (m)     base      tris   notes');

const notes = [];
const measured = [];
let total = 0, used = 0;
for (const ni of g.scenes[g.scene || 0].nodes) {
  const n = g.nodes[ni];
  if (n.mesh == null) continue;
  const m = g.meshes[n.mesh];
  const s = n.scale || [1, 1, 1], q = n.rotation || [0, 0, 0, 1], t = n.translation || [0, 0, 0];
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  let tris = 0;
  for (const p of m.primitives) {
    tris += (p.indices != null ? g.accessors[p.indices].count : g.accessors[p.attributes.POSITION].count) / 3;
    const P = positions(p);
    for (let i = 0; i < P.length; i += 3) {
      const v = rot(q, [P[i] * s[0], P[i + 1] * s[1], P[i + 2] * s[2]]);
      for (let k = 0; k < 3; k++) { const w = v[k] + t[k]; if (w < lo[k]) lo[k] = w; if (w > hi[k]) hi[k] = w; }
    }
  }
  tris = Math.round(tris);
  total += tris;
  const d = hi.map((v, i) => v - lo[i]);
  const entry = manifest.map?.[n.name];
  const type = entry?.type === 'skip' ? 'skip' : (entry?.type || typeFromName(n.name));
  const want = WANT[type];
  const note = [];
  if (!type) note.push('UNMAPPED — rename it in Blender or add it to manifest.json');
  else if (type === 'skip') note.push('skipped by manifest' + (entry.why ? ': ' + entry.why : ''));
  else {
    used += tris;
    const k = want[0] / d[1];
    if (entry?.fit) note.push('fitted to the game box for this prop (proportions NOT kept)');
    else if (entry?.length) note.push(`scaled to ${entry.length} m long`);
    else if (k < 0.7 || k > 1.4) note.push(`rescaled x${k.toFixed(2)} to ${want[0]} m`);
    if (tris > want[1]) note.push(`${(tris / want[1]).toFixed(0)}x the ${want[1]}-tri budget`);
    if (Math.abs(lo[1]) > 0.02 * Math.max(1, d[1])) note.push(`origin ${lo[1] > 0 ? 'above' : 'below'} the base by ${Math.abs(lo[1]).toFixed(2)} m`);
  }
  console.log(`  ${(n.name || '?').padEnd(20)} ${String(type || '-').padEnd(9)} ${d.map((v) => v.toFixed(2).padStart(6)).join(' ')}  ${lo[1].toFixed(2).padStart(7)} ${String(tris).padStart(7)}   ${note.join('; ')}`);
  measured.push([n.name, d, type, entry]);
  if (note.length && type && type !== 'skip') notes.push([n.name, note]);
}

// Publish what each prop ACTUALLY measures once scaled, so the headless tools ride the same rail
// the game draws. Nothing is stretched to fit a constant any more, so the constant has to follow.
{
  const out = {};
  for (const [name, dims, type, entry] of measured) {
    if (!type || type === 'skip') continue;
    const f = finalSize(entry, type, dims).map((v) => +v.toFixed(3));
    // Every variant, in the order the loader will see them -- a rail's surface comes from the
    // variant that rail was given, so one number per type would be wrong for two rails in three.
    (out[type] ||= []).push(f);
    void name;
  }
  fs.writeFileSync(path.join(path.dirname(file), 'sizes.json'), JSON.stringify(out, null, 2));
  console.log('');
  console.log('wrote sizes.json  ' + Object.entries(out).map(([k, v]) => `${k} ${v.map((d) => d.join('x')).join(' / ')}`).join('  '));
}

console.log('');
console.log(`${total} triangles in the file, ${used} of them mapped to props.`);
console.log('');
console.log('The loader fixes size and origin for you — those notes are only so you know it happened.');
console.log('Triangle count it cannot fix: a prop is drawn hundreds of times, so a tree at 10,000');
console.log('triangles is a million triangles of forest. Decimate in Blender, or drop the segment');
console.log('count on the shape you built it from.');
console.log('');
console.log('Name an object pine / fir / birch / rock / boulder / rail / hut / lamp / sign / snowman');
console.log('/ fence and it needs no manifest entry at all. pine, pine.001 and pine_2 are three');
console.log('variants of the same prop, and the game spreads them across the forest.');
