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
// This carries MOMENTUM rather than following the gradient exactly, because a pure steepest-descent
// walker latches onto any bench it meets and rides it round the hill forever -- it reported three of
// six descents "trapped" on a cat track that a rider crosses in two seconds. What is being asked is
// where the hill takes a rider, so the tracer has to be one. Drainage is checked separately, by the
// ponding test below, which is the question a gradient walker is actually the right tool for.
function fall(x0, z0, steps = 900) {
  let x = x0, z = z0, vx = 0, vz = 0; const hd = [];
  for (let i = 0; i < steps; i++) {
    const gx = (H(x + 3, z) - H(x - 3, z)) / 6, gz = (H(x, z + 3) - H(x, z - 3)) / 6;
    const nrm = Math.sqrt(1 + gx * gx + gz * gz);
    const sp = Math.hypot(vx, vz);
    const fr = 9.81 * 0.034 / nrm + 0.0022 * sp * sp;          // snow friction plus air drag
    vx += (-9.81 * gx / nrm - (sp > 1e-3 ? fr * vx / sp : 0)) * 0.12;
    vz += (-9.81 * gz / nrm - (sp > 1e-3 ? fr * vz / sp : 0)) * 0.12;
    x += vx * 0.12; z += vz * 0.12;
    const d = Math.hypot(vx, vz); if (i > 40 && d < 0.35) break;
    if (Math.abs(x) > 500 || z > 1005 || z < 4) break;
    if (d > 1e-3) hd.push(Math.atan2(vx, vz) * 180 / Math.PI);
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

// ---------------------------------------------------------------------------
// The checks below exist because a critic found each of these by measuring something the
// harness above did not, and a defect a harness cannot see is one that comes back.

// 6. CAN YOU GET OFF THE TOP? The rim used to be a pure function of distance from the village,
//    which makes it a closed ring rather than a rim: every one of seventeen bearings crossed
//    55-63 degrees on the way down and the lift unloaded you above it. This walks the actual
//    steepest-descent line from each declared drop-in, each lift top and the start gate, because
//    a bearing swept from the fixed origin is NOT the bearing the generator builds on -- the
//    valley axis leans 165 m east as it climbs, and measuring the wrong slice of hill was how
//    the first version of this check reported 60 degrees on a ramp that is actually 37.
{
  const drop = (x0, z0) => {
    let x = x0, z = z0, worst = 0;
    for (let i = 0; i < 100; i++) {                       // 100 x 3 m = the first 300 m down
      const gx = H(x + 3, z) - H(x - 3, z), gz = H(x, z + 3) - H(x, z - 3);
      const g = Math.hypot(gx, gz); if (g < 1e-4) break;
      x -= (gx / g) * 3; z -= (gz / g) * 3;
      if (Math.abs(x) > 500 || z > 1005 || z < 4) break;
      worst = Math.max(worst, slopeDegAt(m, x, z));
    }
    return Math.round(worst);
  };
  const named = [...(m.dropIns || []).map((p, i) => [`drop-in ${i + 1}`, p.x, p.z]),
                 ...m.lifts.map((l) => [l.name + ' top', l.top.x, l.top.z]),
                 ['start gate', m.start.x, m.start.z]];
  console.log('');
  console.log('GETTING OFF THE TOP (worst slope in the first 300 m of the fall line):');
  for (const [n, x, z] of named) console.log('  ' + n.padEnd(22), `${String(drop(x, z)).padStart(3)}deg`);

  // and the same question asked of the whole summit band, not just the places we put a sign
  let hi = -1e9;
  for (let i = 0; i < m.heights.length; i++) if (m.heights[i] > hi) hi = m.heights[i];
  let lo = 1e9;
  for (let i = 0; i < m.heights.length; i++) if (m.heights[i] < lo) lo = m.heights[i];
  const cut = hi - (hi - lo) * 0.18;
  let band = 0, rideable = 0;
  for (let z = 10; z < 600; z += 10) for (let x = -490; x <= 490; x += 10) {
    if (H(x, z) < cut) continue;
    band++; if (drop(x, z) <= 45) rideable++;
  }
  console.log(`  top 18% of the drop: ${(100 * rideable / Math.max(1, band)).toFixed(0)}% of it has an exit under 45deg (${band} samples)`);
}

// 7. IS THE SUMMIT THE SUMMIT? Its high point used to be the west edge of the map, 82 m above
//    where the lift drops you, so the mountain had no top.
{
  let hi = -1e9, at = null;
  for (let z = 0; z < m.size.h; z++) for (let x = 0; x < m.size.w; x++) {
    const [wx, wz] = gridToWorld(m, x, z); const y = m.heights[z * m.size.w + x];
    if (y > hi) { hi = y; at = [Math.round(wx), Math.round(wz)]; }
  }
  const edge = Math.max(...[-505, 505].flatMap(x => Array.from({ length: 40 }, (_, i) => H(x, 20 + i * 25))));
  console.log(`HIGH POINT: ${hi.toFixed(0)} m at (${at}); highest map-edge ground ${edge.toFixed(0)} m` +
              `  -> peak clears the edge by ${(hi - edge).toFixed(0)} m`);
}

// 8. THE RUN-OUT. Every descent used to end in the same 164-176 m of ground too flat to carry
//    speed on -- at mu = 0.034 you need about 7.5 degrees to hold 15 m/s.
{
  const trace = (x0, z0) => {
    let x = x0, z = z0, vx = 0, vz = 0, run = 0, last = 0;       // a rider, for the reason above
    for (let i = 0; i < 3000; i++) {
      const gx = (H(x + 3, z) - H(x - 3, z)) / 6, gz = (H(x, z + 3) - H(x, z - 3)) / 6;
      const nrm = Math.sqrt(1 + gx * gx + gz * gz), sp = Math.hypot(vx, vz);
      const fr = 9.81 * 0.034 / nrm + 0.0022 * sp * sp;
      vx += (-9.81 * gx / nrm - (sp > 1e-3 ? fr * vx / sp : 0)) * 0.1;
      vz += (-9.81 * gz / nrm - (sp > 1e-3 ? fr * vz / sp : 0)) * 0.1;
      const step = Math.hypot(vx, vz) * 0.1;
      x += vx * 0.1; z += vz * 0.1;
      if (i > 50 && Math.hypot(vx, vz) < 0.35) break;
      if (Math.abs(x) > 500 || z > 1005 || z < 4) break;
      if (slopeDegAt(m, x, z) < 7.5) run += step; else run = 0;
      last = run;
    }
    run = last;
    // The FINAL flat, not the longest one anywhere. A cat track is legitimately under 7.5 degrees
    // for a kilometre and a descent that chooses to follow one has not gone wrong; what this check
    // exists to catch is every run ending in the same long dead apron above the village.
    return run;
  };
  const seeds = [[20, 60], [-180, 120], [190, 130], [0, 300], [-280, 420], [300, 430], [-60, 500], [120, 620]];
  const outs = seeds.map(([x, z]) => trace(x, z));
  console.log(`RUN-OUT: final flat stretch under 7.5deg on 8 descents: ${outs.map((v) => Math.round(v)).join(', ')} m  (max ${Math.round(Math.max(...outs))})`);
}

// 9. WHERE DO RIDERS ACTUALLY STOP? Steepest descent stalls on anything level; this carries
//    momentum, so it finds the traps a gradient trace cannot tell apart from a bench.
{
  let stops = 0, n = 0; const where = new Map();
  for (let z = 60; z < 900; z += 40) for (let x = -460; x <= 460; x += 40) {
    if (H(x, z) < -5) continue;
    n++;
    let px = x, pz = z, vx = 0, vz = 0;
    for (let i = 0; i < 2400; i++) {
      const gx = (H(px + 3, pz) - H(px - 3, pz)) / 6, gz = (H(px, pz + 3) - H(px, pz - 3)) / 6;
      const g2 = gx * gx + gz * gz, nrm = Math.sqrt(1 + g2);
      const ax = -9.81 * gx / nrm, az = -9.81 * gz / nrm;          // gravity along the surface
      const sp = Math.hypot(vx, vz);
      const fr = 9.81 * 0.034 / nrm + 0.0022 * sp * sp;            // snow friction plus air
      vx += (ax - (sp > 1e-3 ? fr * vx / sp : 0)) * 0.1;
      vz += (az - (sp > 1e-3 ? fr * vz / sp : 0)) * 0.1;
      px += vx * 0.1; pz += vz * 0.1;
      if (Math.abs(px) > 498 || pz > 1000 || pz < 6) break;
      if (i > 60 && Math.hypot(vx, vz) < 0.35) {
        stops++;
        const k = `${Math.round(px / 50) * 50},${Math.round(pz / 50) * 50}`;
        where.set(k, (where.get(k) || 0) + 1);
        break;
      }
    }
  }
  const top = [...where.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`STALLS: ${stops} of ${n} drop-ins come to a stop (${(100 * stops / n).toFixed(1)}%)` +
              (top.length ? `; worst spots ${top.map(([k, v]) => `(${k})x${v}`).join(' ')}` : ''));
}

// 10. how steep is it overall -- a mountain that fixes its traps by becoming a cliff is not fixed
{
  let over45 = 0, over50 = 0, tot2 = 0;
  for (let z = 20; z < 1000; z += 8) for (let x = -480; x <= 480; x += 8) {
    const s = slopeDegAt(m, x, z); tot2++;
    if (s > 45) over45++; if (s > 50) over50++;
  }
  console.log(`STEEPNESS: ${(100 * over45 / tot2).toFixed(1)}% over 45deg, ${(100 * over50 / tot2).toFixed(1)}% over 50deg`);
}

// 11. IS IT STILL A CONE? The critic's sharpest number: bin the surface by distance from the base
//     and measure how far each cell departs from its own band's mean. A mountain whose height is a
//     1-D function of that distance is a cone with decorations on it, however many features it has.
{
  const BW = 30, bins = new Map();
  for (let z = 6; z < m.size.h - 6; z += 2) for (let x = 6; x < m.size.w - 6; x += 2) {
    const [wx, wz] = gridToWorld(m, x, z);
    const d = Math.hypot(wx, 905 - wz), k = Math.round(d / BW);
    const y = m.heights[z * m.size.w + x];
    const b = bins.get(k) || { n: 0, s: 0, v: [] };
    b.n++; b.s += y; b.v.push(y); bins.set(k, b);
  }
  let tot = 0, wsum = 0; const line = [];
  for (const [k, b] of [...bins.entries()].sort((a, c) => a[0] - c[0])) {
    if (b.n < 40) continue;
    const mean = b.s / b.n;
    const sd = Math.sqrt(b.v.reduce((a2, y) => a2 + (y - mean) ** 2, 0) / b.n);
    tot += sd * b.n; wsum += b.n;
    if (k % 4 === 0) line.push(`${k * BW}m:${sd.toFixed(1)}`);
  }
  console.log(`RELIEF: mean departure from a pure cone ${(tot / wsum).toFixed(1)} m  [${line.join(' ')}]`);
}
