// Measures a map instead of looking at it: whether the fall lines actually reach the base and
// how far they bend on the way, where the closed depressions are, whether the summit is the high
// point, and how much of the hill is more than 100 m from anything. Every one of these caught a
// defect that screenshots did not.  Run: node tools/map-check.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { deserializeMap, heightAt, slopeDegAt, gridToWorld } from '../public/shared/mapformat.js';
const __d = path.dirname(fileURLToPath(import.meta.url));
const m = deserializeMap(fs.readFileSync(path.join(__d, '..', 'maps', 'alpine-bowl.json'), 'utf8'));
const H = (x, z) => heightAt(m, x, z);

// 1. does the fall line bend?
function fall(x0, z0, steps = 900) {
  let x = x0, z = z0; const hd = [];
  for (let i = 0; i < steps; i++) {
    const gx = H(x + 3, z) - H(x - 3, z), gz = H(x, z + 3) - H(x, z - 3);
    const d = Math.hypot(gx, gz); if (d < 1e-4) break;
    const dx = -gx / d, dz = -gz / d;
    x += dx * 3; z += dz * 3;
    if (Math.abs(x) > 500 || z > 1005 || z < 4) break;
    hd.push(Math.atan2(dx, dz) * 180 / Math.PI);
  }
  if (hd.length < 20) return null;
  const at = (f) => hd[Math.min(hd.length - 1, Math.round(hd.length * f))];
  return { end: [Math.round(x), Math.round(z)], turn: Math.round(at(0.9) - at(0.1)),
           path: [0.1,0.35,0.6,0.9].map(f => Math.round(at(f))) };
}
console.log('FALL LINES (heading in degrees off +z, at 10/35/60/90% of the descent):');
for (const [n, x, z] of [['start gate', 20, 60], ['upper west', -180, 120], ['upper east', 190, 130],
                          ['centre high', 0, 300], ['mid west', -280, 420], ['mid east', 300, 430]]) {
  const f = fall(x, z);
  console.log('  ' + n.padEnd(12), f ? `${String(f.path).padEnd(22)} total turn ${String(f.turn).padStart(4)}deg  ends (${f.end})` : 'stalled');
}

// 2. the z=906 seam and the worst slopes
let worstSeam = 0, wsx = 0;
for (let x = -500; x <= 500; x += 6) {
  const s = Math.max(slopeDegAt(m, x, 903), slopeDegAt(m, x, 906), slopeDegAt(m, x, 909));
  if (s > worstSeam) { worstSeam = s; wsx = x; }
}
console.log(`\nSEAM at z~906: worst slope ${worstSeam.toFixed(0)}deg at x=${wsx}`);

// 3. closed depressions (a coarse flood check)
let pits = 0, worstPit = 0, pitAt = null; const pitList = [];
for (let z = 8; z < m.size.h - 8; z += 2) for (let x = 8; x < m.size.w - 8; x += 2) {
  const [wx, wz] = gridToWorld(m, x, z); const h0 = H(wx, wz);
  let lower = false, rim = Infinity;
  for (let a = 0; a < 8; a++) {
    const t = a / 8 * Math.PI * 2, hh = H(wx + Math.cos(t) * 14, wz + Math.sin(t) * 14);
    if (hh < h0 - 0.2) { lower = true; break; }
    rim = Math.min(rim, hh);
  }
  if (!lower && rim - h0 > 1.5) { pits++; pitList.push([Math.round(wx), Math.round(wz), +(rim-h0).toFixed(1)]); if (rim - h0 > worstPit) { worstPit = rim - h0; pitAt = [Math.round(wx), Math.round(wz)]; } }
}
console.log(`PITS deeper than 1.5 m: ${pits}${pitAt ? `, worst ${worstPit.toFixed(1)} m at (${pitAt})` : ''}`);
pitList.sort((a,b)=>b[2]-a[2]); console.log('  deepest:', pitList.slice(0,8).map(p=>`(${p[0]},${p[1]})=${p[2]}m`).join(' '));

// 4. summit vs the map corners
const corners = [[-500,20],[500,20],[-500,1000],[500,1000]].map(([x,z]) => H(x,z));
console.log(`\nSUMMIT: start gate ${H(m.start.x, m.start.z).toFixed(0)} m | top-edge centre ${H(0,10).toFixed(0)} m | corners ${corners.map(v=>v.toFixed(0))}`);

// 5. how far from a feature
const feats = m.props.filter(p => ['hut','sign','lamp','snowman','rock','boulder'].includes(p.t)).map(p => [p.x, p.z]);
for (const l of m.lifts) { feats.push([l.base.x, l.base.z]); feats.push([l.top.x, l.top.z]); }
let far = 0, farAt = null, n100 = 0, tot = 0;
for (let z = 20; z < 1000; z += 16) for (let x = -480; x <= 480; x += 16) {
  if (H(x, z) < -5) continue;
  let best = 1e9;
  for (const [fx, fz] of feats) { const d2 = (fx-x)**2 + (fz-z)**2; if (d2 < best) best = d2; }
  const d = Math.sqrt(best); tot++;
  if (d > 100) n100++;
  if (d > far) { far = d; farAt = [x, z]; }
}
console.log(`EMPTINESS: ${(100*n100/tot).toFixed(1)}% of the hill is >100 m from any feature; worst ${far.toFixed(0)} m at (${farAt})`);
