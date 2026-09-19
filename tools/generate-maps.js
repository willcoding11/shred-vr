// Generates the three starter maps into ./maps. Run: npm run gen-maps
//
// Design rule that drives most of the numbers below: the rideable floor must be NARROWER
// than the feature it is meant to shape. If the flat floor is wider than the gully's swing
// or the berm's offset, the rider's feet never feel the terrain and the shape is decoration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMap, serializeMap, applyBrush, fbm, gridToWorld, baseHeight, mapStats,
  slopeDegAt, PROP_TYPES,
} from '../public/shared/mapformat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS = path.join(__dirname, '..', 'maps');
fs.mkdirSync(MAPS, { recursive: true });

// ---------------- helpers ----------------
const rnd = (seed) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; };
const smooth01 = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const deg = (d) => Math.tan((d * Math.PI) / 180);

// Cross-section: a flat floor of `floorHalf` metres either side of `centerFn`, then a wall that
// climbs `wallH` metres over `wallRun` metres, then a gentle continuing rise out to the map edge.
// All in metres, so the wall angle is what you asked for regardless of map width.
function shapeValley(map, { floorHalf = 30, wallH = 10, wallRun = 34, pow = 1.8, outerGrade = 0.22, centerFn = () => 0 }) {
  const { w, h } = map.size;
  const halfAt = typeof floorHalf === 'function' ? floorHalf : () => floorHalf;
  for (let z = 0; z < h; z++) {
    const wz = z * map.spacing, cx = centerFn(wz), fh = halfAt(wz);
    for (let x = 0; x < w; x++) {
      const [wx] = gridToWorld(map, x, z);
      const d = Math.abs(wx - cx) - fh;
      if (d <= 0) continue;
      const t = Math.min(1, d / wallRun);
      let dy = Math.pow(t, pow) * wallH;
      if (d > wallRun) dy += (d - wallRun) * outerGrade;      // keep climbing: the map edge is unmistakable
      map.heights[z * w + x] += dy;
    }
  }
}
function addNoise(map, { amp = 0.4, scale = 0.03, oct = 3, seed = 0, mask = () => 1 }) {
  const { w, h } = map.size;
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const [wx, wz] = gridToWorld(map, x, z);
    map.heights[z * w + x] += fbm(wx * scale + seed, wz * scale + seed * 3, oct) * amp * mask(wx, wz);
  }
}
// Rollers: sinusoidal waves along the fall line.
function addRollers(map, { z0, z1, wavelength = 40, amp = 1.2, fade = 25 }) {
  const { w, h } = map.size;
  for (let z = 0; z < h; z++) {
    const wz = z * map.spacing;
    if (wz < z0 - fade || wz > z1 + fade) continue;
    const env = Math.min(1, Math.max(0, (wz - z0 + fade) / fade), Math.max(0, (z1 + fade - wz) / fade));
    const v = (Math.sin(((wz - z0) / wavelength) * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5) * amp * env;
    for (let x = 0; x < w; x++) map.heights[z * w + x] += v;
  }
}
// A slow alternating cross-camber, so even an open floor suggests a rhythm to follow.
function addCamber(map, { z0, z1, wavelength = 150, amp = 1.5, reach = 40, centerFn = () => 0 }) {
  const { w, h } = map.size;
  for (let z = 0; z < h; z++) {
    const wz = z * map.spacing; if (wz < z0 || wz > z1) continue;
    const env = Math.min(1, (wz - z0) / 40, (z1 - wz) / 40);
    const phase = Math.sin(((wz - z0) / wavelength) * Math.PI * 2);
    for (let x = 0; x < w; x++) {
      const [wx] = gridToWorld(map, x, z);
      const u = Math.max(-1, Math.min(1, (wx - centerFn(wz)) / reach));
      map.heights[z * w + x] += phase * u * amp * env;
    }
  }
}
// Set the centreline grade as a function of z. The grade is box-filtered before integrating so
// piecewise joints do not become hard terraces running across the whole hill.
function pitchProfile(map, gradeFn, { smoothM = 30 } = {}) {
  const { w, h } = map.size, sp = map.spacing;
  const raw = new Float32Array(h);
  for (let z = 0; z < h; z++) raw[z] = gradeFn(z * sp);
  const k = Math.max(0, Math.round(smoothM / sp));
  const g = new Float32Array(h);
  for (let z = 0; z < h; z++) {
    let s = 0, c = 0;
    for (let d = -k; d <= k; d++) { s += raw[Math.min(h - 1, Math.max(0, z + d))]; c++; }
    g[z] = s / c;
  }
  let y = map.base.h0;
  const prof = new Float32Array(h);
  for (let z = 0; z < h; z++) { prof[z] = y; y -= deg(g[z]) * sp; }
  for (let z = 0; z < h; z++) {
    const dy = prof[z] - baseHeight(map, z * sp);
    for (let x = 0; x < w; x++) map.heights[z * w + x] += dy;
  }
}
// Start pad: a gently sloped platform so riders can get rolling without being launched.
function startPad(map, { z0, z1, blend = 14, gradeDeg = 4.5, halfWidth = 50, edgeBlend = 18 }) {
  const { w, h } = map.size, sp = map.spacing;
  const y0 = map.heights[Math.round(z0 / sp) * w + (w >> 1)];
  for (let z = 0; z < h; z++) {
    const wz = z * sp;
    if (wz > z1 + blend) break;
    const kz = wz <= z1 ? 1 : 1 - (wz - z1) / blend;
    const target = y0 - (wz - z0) * deg(gradeDeg);
    for (let x = 0; x < w; x++) {
      const [wx] = gridToWorld(map, x, z);
      // fade out across the width so the pad never flattens the valley sides
      const kx = 1 - smooth01((Math.abs(wx) - halfWidth) / edgeBlend);
      const k = kz * kx;
      if (k <= 0) continue;
      map.heights[z * w + x] += (target - map.heights[z * w + x]) * k;
    }
  }
}
// Re-profile the centreline from z0 to the map end: ease the current grade into a gentle
// counter-slope so riders coast to a stop. The cross-section (valley walls) is preserved.
function runout(map, { z0, counterDeg = 4, blend = 50 }) {
  const { w, h } = map.size, sp = map.spacing, mid = w >> 1;
  const i0 = Math.max(1, Math.round(z0 / sp));
  const g0 = (map.heights[i0 * w + mid] - map.heights[(i0 + 4) * w + mid]) / (4 * sp);
  const gEnd = -deg(counterDeg);
  let y = map.heights[i0 * w + mid];
  for (let z = i0; z < h; z++) {
    const wz = z * sp;
    const dy = y - map.heights[z * w + mid];
    for (let x = 0; x < w; x++) map.heights[z * w + x] += dy;
    const s = smooth01((wz - z0) / blend);
    y -= (g0 * (1 - s) + gEnd * s) * sp;
  }
}
// Additive take-off ramp. `radius` is the half-length, `height` the lip rise above the slope.
function kicker(map, x, z, { radius = 14, height = 4, yaw = 0 } = {}) {
  applyBrush(map, { tool: 'kicker', x, z, radius, height, yaw });
}
// A banked turn ON the rider's line. `offset` is metres from the line to the inside foot of the
// bank; the crest lands at offset + 0.72*radius and rises `height` metres over that run.
function berm(map, { x, z, offset, side, radius = 22, height = 8, length = 0, clearWall = true }) {
  const half = length ? length / 2 : radius;
  // A bank has to REPLACE the valley wall it sits on, not sit on top of it -- otherwise the
  // two rises add and the face ends up far steeper than the number asked for.
  if (clearWall) {
    const { w, h } = map.size, sp = map.spacing;
    const x0 = x + offset * side, reach = radius * 2.9;
    for (let zz = 0; zz < h; zz++) {
      const wz = zz * sp;
      const u = (wz - z) / half;
      if (Math.abs(u) >= 1) continue;
      const alongK = 1 - smooth01((Math.abs(u) - 0.5) / 0.5);
      const yFloor = map.heights[zz * w + Math.round((x / sp) + (w - 1) / 2)];
      for (let xx = 0; xx < w; xx++) {
        const [wx] = gridToWorld(map, xx, zz);
        const d = (wx - x0) * side;
        if (d < -2 || d > reach) continue;
        // recover the original wall gradually across the WHOLE reach; a short taper leaves a
        // step where the flattening stops, which reads as a cliff beside the bank
        const k = alongK * (1 - smooth01(d / reach));
        const i = zz * w + xx;
        if (map.heights[i] > yFloor) map.heights[i] += (yFloor - map.heights[i]) * k;
      }
    }
  }
  applyBrush(map, {
    tool: 'bank', x: x + offset * side, z, radius, strength: 1, dt: height / 10, yaw: 0, side,
    bLen: half,
  });
}
function smoothAll(map, passes = 1, mask = () => 1) {
  const { w, h } = map.size;
  for (let p = 0; p < passes; p++) {
    const src = Float32Array.from(map.heights);
    for (let z = 1; z < h - 1; z++) for (let x = 1; x < w - 1; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const m = mask(wx, wz); if (m <= 0) continue;
      const i = z * w + x;
      const avg = (src[i - 1] + src[i + 1] + src[i - w] + src[i + w]) * 0.2 + src[i] * 0.2;
      map.heights[i] += (avg - src[i]) * m;
    }
  }
}
function place(map, t, x, z, extra = {}) {
  // Off the map is not a place. On the open mountain everything is positioned by bearing and
  // distance, and its valley axis leans 165 m east as it climbs, so a bearing that sits comfortably
  // on the hill low down walks off the edge higher up: 48 props ended up standing in the void past
  // x = 508, the furthest at x = 988.
  const hx = ((map.size.w - 1) * map.spacing) / 2, zMax = (map.size.h - 1) * map.spacing;
  if (!(x >= -hx && x <= hx && z >= 0 && z <= zMax)) return;
  map.props.push({ t, x: +x.toFixed(2), z: +z.toFixed(2), s: extra.s ?? 1, r: extra.r ?? 0 });
}
// A forest edge: trees at a jittered inset so it reads as a treeline, not a fence.
function treeLine(map, rand, { side, z0, z1, spacing = 7, jitter = 5, types = ['pine', 'pine', 'fir'], inset = 6, insetVar = 12, cx = () => 0 }) {
  const halfW = ((map.size.w - 1) * map.spacing) / 2;
  for (let z = z0; z < z1; z += spacing + rand() * jitter) {
    const x = cx(z) + side * (halfW - inset - rand() * insetVar);
    if (Math.abs(x) > halfW - 3) continue;
    place(map, types[Math.floor(rand() * types.length)], x, z, { s: 0.8 + rand() * 0.7, r: rand() * 6.28 });
  }
}
// Trees at a fixed distance either side of a (possibly winding) centreline.
function corridor(map, rand, { z0, z1, cx, offset = 45, offsetVar = 10, spacing = 6, rows = 2, rowGap = 11, types = ['pine', 'pine', 'fir'] }) {
  const halfW = ((map.size.w - 1) * map.spacing) / 2;
  for (let z = z0; z < z1; z += spacing + rand() * 4) {
    for (const side of [-1, 1]) for (let r = 0; r < rows; r++) {
      if (r > 0 && rand() < 0.35) continue;
      const x = cx(z) + side * (offset + rand() * offsetVar + r * rowGap);
      if (Math.abs(x) > halfW - 3) continue;
      place(map, types[Math.floor(rand() * types.length)], x, z + rand() * 3, { s: 0.8 + rand() * 0.8, r: rand() * 6.28 });
    }
  }
}
// Loose clumps of trees, Poisson-ish, between `inner` and `halfWidth` of the centreline.
function glade(map, rand, { z0, z1, cx = () => 0, halfWidth = 40, inner = 0, density = 0.004, types = ['pine', 'fir', 'birch'], minGap = 9, sides = [-1, 1], reject = null }) {
  const n = Math.floor((z1 - z0) * (halfWidth - inner) * sides.length * density);
  const placed = [];
  const halfW = ((map.size.w - 1) * map.spacing) / 2;
  for (let i = 0; i < n * 6 && placed.length < n; i++) {
    const z = z0 + rand() * (z1 - z0);
    const off = inner + rand() * (halfWidth - inner);
    const x = cx(z) + sides[Math.floor(rand() * sides.length)] * off;
    if (Math.abs(x) > halfW - 4) continue;
    if (reject && reject(x, z)) continue;
    if (placed.some((p) => Math.hypot(p[0] - x, p[1] - z) < minGap)) continue;
    placed.push([x, z]);
    place(map, types[Math.floor(rand() * types.length)], x, z, { s: 0.8 + rand() * 0.8, r: rand() * 6.28 });
  }
}

// Anything that crashes a rider has no business standing on ground too steep to ride: those
// are cliff faces and chute walls, where a tree is both implausible and unfair.
function pruneSteepProps(map, maxDeg = 38) {
  const before = map.props.length;
  map.props = map.props.filter((p) => {
    const def = PROP_TYPES[p.t];
    if (!def || !def.hard) return true;
    return slopeDegAt(map, p.x, p.z) <= maxDeg;
  });
  return before - map.props.length;
}

// Slalom line solved from geometry rather than drawn on a plan. For a smooth S of lateral
// swing S over a run L the tightest radius is R = 2L^2/(pi^2 * S); inverting that gives the
// spacing needed to keep the demand at `targetR` as the swing grows.
function slalomLine({ z0, zEnd, swing0, swing1, targetR, cx = () => 0, startSide = -1 }) {
  const out = [];
  let z = z0, side = startSide;
  while (z <= zEnd) {
    const t = (zEnd - z0) > 0 ? Math.min(1, (z - z0) / (zEnd - z0)) : 1;
    const amp = swing0 + (swing1 - swing0) * t;
    out.push([+(cx(z) + side * amp).toFixed(2), +z.toFixed(1)]);
    z += Math.PI * Math.sqrt(targetR * amp);       // full swing between gates is 2*amp
    side = -side;
  }
  return out;
}
function finish(map, z, w = 34, x = 0) { map.finish = { x, z, w }; }

// Dress the top of the run: a fence funnel and a couple of markers so it reads as a start.
function startArea(map, { z, x = 0, width = 22 }) {
  place(map, 'sign', x - 9, z - 8, { r: Math.PI });
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      place(map, 'fence', x + side * (width / 2 + i * 6.2), z - 6 + i * 3.5, { r: 0.22 * side });
      if (i % 2 === 0) place(map, 'flag', x + side * (width / 2 - 2 + i * 6), z + 4 + i * 6);
    }
  }
  place(map, 'lamp', x - width / 2 - 4, z + 2); place(map, 'lamp', x + width / 2 + 4, z + 2);
}
// Dress the bottom: fences converging into the line, then a small base area past it.
function finishArea(map, { z, x = 0, w = 40 }) {
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      // every post stays clear of the banner (the game scores |dx| <= w/2 + 1)
      place(map, 'fence', x + side * (w / 2 + 7 + 24 * (1 - t)), z - 44 + i * 10, { r: 0.3 * side });
    }
    place(map, 'flag', x + side * (w / 2 - 3), z - 3);
    place(map, 'lamp', x + side * (w / 2 + 5), z + 1);
  }
  place(map, 'hut', x - w / 2 - 26, z + 38, { r: 0.5 });
  place(map, 'snowman', x + 12, z + 22);
  place(map, 'snowman', x + 17, z + 26, { s: 0.8 });
  place(map, 'sign', x + w / 2 + 10, z + 16, { r: Math.PI });
  for (let i = 0; i < 6; i++) place(map, 'flag', x - 26 + i * 10, z + 44 + (i % 2) * 6);
}

// ---------------- MAP 1: First Tracks (green) ----------------
function firstTracks() {
  const map = createMap({ id: 'first-tracks', name: 'First Tracks', w: 96, h: 400, spacing: 2, slopeDeg: 10, h0: 0, difficulty: 'green' });
  map.description = 'A wide, forgiving groomer with soft rollers and a proper banked turn. Learn to link turns.';
  map.order = 1;
  const rand = rnd(11);
  pitchProfile(map, (z) => (
    z < 40 ? 6
      : z < 120 ? 6 + ((z - 40) / 80) * 4
        : z < 165 ? 10
          : z < 310 ? 12
            : z < 470 ? 10
              : z < 560 ? 10 - ((z - 470) / 90) * 3
                : 7), { smoothM: 34 });
  // Floor is 34 m either side: narrower than the gate swing, so the shaping is always
  // underfoot rather than out at the map edge.
  shapeValley(map, { floorHalf: 34, wallH: 7, wallRun: 30, pow: 1.7, outerGrade: 0.2 });
  addNoise(map, { amp: 0.35, scale: 0.02, oct: 3, seed: 1.7 });
  addNoise(map, { amp: 0.12, scale: 0.09, oct: 2, seed: 4.1 });
  // Phase matters: the camber's low side must fall where the gate line already wants the
  // rider, or the only rhythm cue on the map fights its own course.
  addCamber(map, { z0: 90, z1: 560, wavelength: 152, amp: -1.4, reach: 34 });
  addRollers(map, { z0: 175, z1: 300, wavelength: 42, amp: 1.3 });
  addRollers(map, { z0: 455, z1: 556, wavelength: 38, amp: 1.0 });   // the bottom third had nothing in it
  // A real banked left-hander: 70 m long so it is a bank you ride, not a mound you launch.
  berm(map, { x: 0, z: 405, offset: 8, side: 1, radius: 17, height: 5.0, length: 100 });
  startPad(map, { z0: 4, z1: 26, blend: 14, gradeDeg: 4.5, halfWidth: 36 });
  runout(map, { z0: 592, counterDeg: 5, blend: 60 });
  smoothAll(map, 2);
  map.start = { x: 0, z: 14, yaw: 0 };
  finish(map, 580, 64);          // spans the groomer floor, so any line down it scores
  treeLine(map, rand, { side: -1, z0: 40, z1: 690, spacing: 7, inset: 8, insetVar: 16 });
  treeLine(map, rand, { side: 1, z0: 40, z1: 690, spacing: 7, inset: 8, insetVar: 16 });
  glade(map, rand, { z0: 60, z1: 660, halfWidth: 88, inner: 66, density: 0.0022, minGap: 10, types: ['birch', 'pine', 'fir'] });
  // Gate swing GROWS with speed so the rhythm stays constant in time; the last pair arcs
  // across the berm.
  // Solved for a ~45 m radius, which is what a green rider can hold at this map's speeds.
  // Starting on the toe side puts the widest gate on the berm at z~405.
  // (gates removed: the game is free-ride now)
  for (let z = 90; z < 560; z += 90) { place(map, 'flag', -30, z); place(map, 'flag', 30, z); }
  for (let z = 70; z <= 560; z += 100) { place(map, 'lamp', -46, z); place(map, 'lamp', 46, z); }
  startArea(map, { z: 14, x: 0, width: 24 });
  finishArea(map, { z: 580, x: 0, w: 64 });
  pruneSteepProps(map);
  return map;
}

// ---------------- MAP 2: Glade Run (blue) ----------------
function gladeRun() {
  const map = createMap({ id: 'glade-run', name: 'Glade Run', w: 112, h: 480, spacing: 2, slopeDeg: 15, h0: 0, difficulty: 'blue' });
  map.description = 'A winding gully through the trees with banked turns, a gladed pitch and a kicker to finish.';
  map.order = 2;
  const rand = rnd(23);
  const KICK_Z = 686, FREEZE = 535;          // an apex: wind'(FREEZE) = 0, so holding is smooth
  const AMP = 34;
  const wind = (z) => Math.sin(((z - 40) / 220) * Math.PI * 2) * AMP * Math.min(1, (z - 40) / 60);
  // Freeze the gully well before the kicker: the run-in, the lip and the finish all share one
  // straight line, so the jump is set up rather than stumbled into.
  // Freezing at an apex costs nothing in smoothness -- the curve is already flat there -- and
  // gives the kicker, its landing and the finish one long straight line to share.
  const center = (z) => (z < 40 ? 0 : z >= FREEZE ? wind(FREEZE) : wind(z));
  pitchProfile(map, (z) => (
    z < 30 ? 7
      : z < 90 ? 7 + ((z - 30) / 60) * 9
        : z < 520 ? 16
          : z < 640 ? 16 + Math.sin(((z - 520) / 120) * Math.PI) * 4
            : z < 676 ? 14
              : z < 698 ? 11                                  // flat run-in so the lip does the work
                : z < 756 ? 29                                 // landing, pitched to match the flight path
                  : z < 776 ? 29 - ((z - 756) / 20) * 23
                    : 6), { smoothM: 22 });
  // Floor is 14 m either side of the gully -- far less than the 34 m swing -- so the winding
  // is something the board feels, not just something the trees suggest.
  shapeValley(map, { floorHalf: 14, wallH: 10, wallRun: 26, pow: 1.5, outerGrade: 0.22, centerFn: center });
  addNoise(map, { amp: 0.5, scale: 0.025, oct: 3, seed: 2.3 });
  addNoise(map, { amp: 0.18, scale: 0.08, oct: 2, seed: 8.8 });
  // Berms on the outside of each apex, right on the line: crest ~28 m out, ~25 degree face.
  for (const zApex of [95, 205, 315, 425, 535]) {
    const c = center(zApex), side = Math.sign(c) || 1;
    berm(map, { x: c, z: zApex, offset: 12, side, radius: 23, height: 6.2, length: 84 });
  }
  addRollers(map, { z0: 540, z1: 640, wavelength: 34, amp: 1.0 });
  startPad(map, { z0: 4, z1: 24, blend: 12, gradeDeg: 4.5, halfWidth: 20 });
  kicker(map, center(KICK_Z), KICK_Z, { radius: 12, height: 2.8, yaw: 0 });
  runout(map, { z0: 790, counterDeg: 5, blend: 60 });
  smoothAll(map, 2, (x, z) => (z > 664 && z < 706 ? 0.2 : 1));   // keep the lip crisp
  map.start = { x: 0, z: 12, yaw: 0 };
  finish(map, 766, 58, center(KICK_Z));      // wide enough for a hot exit off the kicker
  // Forest sits behind the berms, not on them.
  // The wall does the steering; the trees are the backstop. Leave enough margin between the
  // two that a rider who blows a turn hits snow first and only then trees.
  corridor(map, rand, { z0: 40, z1: 780, cx: center, offset: 52, offsetVar: 10, spacing: 6, rows: 2, rowGap: 12 });
  // A real gladed pitch on the inside of the bends, with a clean lane beside it.
  // A gladed lane on the inside of the bends: a defined band starting 17 m off the gully
  // line, so the gate line stays clean and weaving the trees is a choice, not a tax.
  // Keep the gladed lane clear of the apex banks: trees on a 45 deg berm face are a trap,
  // not a feature, and the apex gate leads riders straight onto them.
  const bermZones = [95, 205, 315, 425, 535].map((za) => ({ z: za, x: center(za) + (Math.sign(center(za)) || 1) * 27 }));
  glade(map, rand, {
    z0: 340, z1: 470, cx: center, halfWidth: 40, inner: 22, density: 0.006, minGap: 10,
    types: ['pine', 'birch', 'fir'], sides: [1],
    reject: (x, z) => bermZones.some((b) => Math.abs(z - b.z) < 46 && Math.abs(x - b.x) < 30),
  });
  // One gate per apex, on the berm face, plus a straight setup gate for the kicker.
  const apexGates = [95, 205, 315, 425, 535].map((za) => {
    const c = center(za), side = Math.sign(c) || 1;
    return [+(c + side * 11).toFixed(2), za];       // on the berm face at each apex
  });
  // (gates removed: the game is free-ride now)
  for (let z = 100; z < 760; z += 80) place(map, 'flag', center(z) + 17, z);
  for (let z = 150; z < 720; z += 110) place(map, 'flag', center(z) - 17, z);
  // Scenery rocks sit out on the wall, clear of any line a rider drifting wide would take.
  for (const z of [240, 380, 500]) {
    const c = center(z), side = Math.sign(center(z + 20) - c) || 1;
    place(map, z % 80 === 0 ? 'boulder' : 'rock', c - side * 34, z, { s: 1 + rand() * 0.5, r: rand() * 3 });
  }
  place(map, 'sign', center(660) - 18, 660, { r: Math.PI });
  startArea(map, { z: 12, x: 0, width: 22 });
  finishArea(map, { z: 766, x: center(KICK_Z), w: 58 });
  pruneSteepProps(map);
  return map;
}

// ---------------- MAP 3: Ridge Line (black) ----------------
function ridgeLine() {
  const map = createMap({ id: 'ridge-line', name: 'Ridge Line', w: 112, h: 512, spacing: 2, slopeDeg: 22, h0: 0, difficulty: 'black' });
  map.description = 'Steep upper face, a cliff band onto a steep landing, a mogul field, then a rock chute to the finish.';
  map.order = 3;
  const rand = rnd(37);
  const CLIFF = 262;
  // One centreline for the whole run: a long swing across the upper face so the approach to
  // the cliff is earned, then straight through the shelf, then the chute.
  const chuteCenter = (z) => (
    z < 70 ? 0
      : z < 240 ? Math.sin(((z - 70) / 170) * Math.PI) * 17
        : z < 560 ? 0
          : z < 700 ? Math.sin(((z - 560) / 140) * Math.PI) * 18
            : 0);
  // The landing under the cliff is deliberately steeper than the drop's flight path, so a
  // rider arriving at any sane speed touches down along the slope instead of into it.
  pitchProfile(map, (z) => (
    z < 24 ? 8
      : z < 70 ? 8 + ((z - 24) / 46) * 18
        : z < 240 ? 26
          : z < CLIFF ? 17                                   // shoulder: flattens into the lip
            : z < 302 ? 46                                    // steep landing under the cliff
              : z < 344 ? 46 - ((z - 302) / 42) * 28
                : z < 420 ? 16                                // shelf + glade
                  : z < 560 ? 20                              // moguls
                    : z < 700 ? 24                            // chute
                      : z < 752 ? 16
                        : z < 792 ? 16 - ((z - 752) / 40) * 9
                          : 7), { smoothM: 16 });
  // The upper face is a narrower corridor so its swing is felt; the shelf opens back out.
  shapeValley(map, {
    floorHalf: (z) => (z < 60 ? 34 : z < 250 ? 16 : z < 300 ? 16 + ((z - 250) / 50) * 28 : 44),
    wallH: 11, wallRun: 30, pow: 1.9, outerGrade: 0.26, centerFn: chuteCenter,
  });
  // Rollers on the upper face: something to pump and something to scrub against.
  addRollers(map, { z0: 92, z1: 226, wavelength: 46, amp: 1.5 });
  addNoise(map, { amp: 0.7, scale: 0.02, oct: 4, seed: 3.9, mask: (x, z) => (z > CLIFF && z < 336 ? 0.3 : 1) });
  addNoise(map, { amp: 0.25, scale: 0.07, oct: 2, seed: 6.2, mask: (x, z) => (z > CLIFF && z < 336 ? 0.4 : 1) });

  // ---- cliff band: a wavy edge whose drop varies across the slope and fades into the walls ----
  const { w, h } = map.size, sp = map.spacing;
  const cliffZ = (x) => CLIFF + fbm(x * 0.012 + 7.3, 2.6, 3) * 7;
  const cliffDrop = (x) => (4.2 + fbm(x * 0.02 + 2.1, 5.4, 2) * 1.1) * (1 - smooth01((Math.abs(x) - 42) / 22));
  for (let z = 0; z < h; z++) {
    const wz = z * sp;
    if (wz < CLIFF - 22) continue;
    for (let x = 0; x < w; x++) {
      const [wx] = gridToWorld(map, x, z);
      const cz = cliffZ(wx), d = cliffDrop(wx);
      if (d < 0.05) continue;
      // Rounded over 4.5 m: the rider drops the face rather than being thrown off a lip.
      map.heights[z * w + x] -= d * smooth01((wz - cz) / 4.5);
    }
  }

  // ---- mogul field 428-556 m: jittered bumps with soft edges ----
  // 9.5 m rows rather than 6.5: at 22 m/s a 6.5 m pitch is 3.4 bumps a second, which skips
  // the board off the crests instead of letting it absorb them.
  for (let row = 0; row * 9.5 < 128; row++) {
    const z = 428 + row * 9.5;
    for (let col = -6; col <= 6; col++) {
      const px = col * 6 + (row % 2 ? 3 : 0) + (rand() - 0.5) * 3;
      const pz = z + (rand() - 0.5) * 3;
      const edgeT = Math.max(Math.abs(px) / 38, Math.abs(pz - 492) / 66);
      if (rand() < Math.max(0, (edgeT - 0.65) / 0.35)) continue;
      applyBrush(map, { tool: 'raise', x: px, z: pz, radius: 4.2 + rand() * 1.8, strength: 1, dt: 0.07 + rand() * 0.045, falloff: 0.05 });
    }
  }

  // ---- chute 520-745 m: a proper couloir, ~20 m floor with 15 m walls ----
  for (let z = 0; z < h; z++) {
    const wz = z * sp; if (wz < 520 || wz > 745) continue;
    const env = smooth01(Math.min((wz - 520) / 45, (745 - wz) / 40));
    const c = chuteCenter(wz);
    const half = 9.5 + fbm(wz * 0.05 + 11.1, 3.3, 2) * 2;
    const wallH = 15 + fbm(wz * 0.04 + 5.5, 8.8, 2) * 3;
    for (let x = 0; x < w; x++) {
      const [wx] = gridToWorld(map, x, z);
      const d = Math.abs(wx - c) - half;
      if (d <= 0) continue;
      const rise = smooth01(d / 11) * (1 - smooth01((d - 40) / 30));
      map.heights[z * w + x] += rise * wallH * env;
    }
  }
  // A bank just inside the chute's right wall, to swing the exit back toward the finish.
  berm(map, { x: 12, z: 712, offset: 0, side: 1, radius: 11, height: 4, length: 64 });

  startPad(map, { z0: 4, z1: 20, blend: 10, gradeDeg: 5, halfWidth: 32 });
  runout(map, { z0: 800, counterDeg: 5, blend: 65 });
  smoothAll(map, 1, (x, z) => (z > 424 && z < 560 ? 0.3 : z > CLIFF - 14 && z < CLIFF + 12 ? 0.35 : 1));
  map.start = { x: 0, z: 10, yaw: 0 };
  finish(map, 792, 62, -6);                 // spans both lines riders actually exit the chute on

  // ---- scenery ----
  treeLine(map, rand, { side: -1, z0: 30, z1: 940, spacing: 5, inset: 10, insetVar: 14, types: ['fir', 'pine'] });
  treeLine(map, rand, { side: 1, z0: 30, z1: 940, spacing: 5, inset: 10, insetVar: 14, types: ['fir', 'pine'] });
  treeLine(map, rand, { side: -1, z0: 40, z1: 420, spacing: 11, inset: 24, insetVar: 10, types: ['fir', 'birch'] });
  treeLine(map, rand, { side: 1, z0: 40, z1: 420, spacing: 11, inset: 24, insetVar: 10, types: ['fir', 'birch'] });
  // Trees flanking the chute, so the bypass is trees rather than open snow.
  glade(map, rand, { z0: 430, z1: 730, cx: chuteCenter, halfWidth: 82, inner: 44, density: 0.0055, minGap: 9, types: ['fir', 'pine'] });
  // start below the cliff's steep fade shoulders, which riders cross at over 100 km/h
  glade(map, rand, { z0: 336, z1: 418, halfWidth: 78, inner: 56, density: 0.003, minGap: 12, types: ['fir', 'fir', 'birch'] });
  // the shelf was 85 m of nothing: give it rollers and a couple of rock outcrops to read
  addRollers(map, { z0: 350, z1: 424, wavelength: 34, amp: 1.2 });
  // out on the shelf's shoulders: scenery to read the width against, not obstacles on the line
  for (const [rx, rz] of [[-54, 366], [52, 388], [-50, 410], [56, 356]]) place(map, 'rock', rx, rz, { s: 1.4 + rand() * 0.5, r: rand() * 3 });
  // Rocks well outside the cliff's roll-in shoulders, so the low-consequence line stays clean.
  // well outside the flagged bypass at |x| = 56, which needs a clean slot either side of it
  for (const x of [-101, -95, 96, 102]) place(map, 'rock', x, CLIFF - 4 + rand() * 8, { s: 1.8 + rand() * 0.6, r: rand() * 3 });
  for (const x of [-105, 105]) place(map, 'boulder', x, CLIFF + 10, { s: 1.2, r: rand() * 3 });
  // Flag the chicken line around the cliff's faded shoulder.
  for (let z = 240; z <= 284; z += 11) { place(map, 'flag', 56, z); place(map, 'flag', -56, z); }
  place(map, 'sign', 62, 236, { r: Math.PI }); place(map, 'sign', -62, 236, { r: Math.PI });
  // Boulders along the chute crests.
  for (let z = 556; z < 726; z += 16) {
    const c = chuteCenter(z), half = 9.5 + fbm(z * 0.05 + 11.1, 3.3, 2) * 2;
    for (const side of [-1, 1]) place(map, rand() < 0.5 ? 'boulder' : 'rock', c + side * (half + 14 + rand() * 6), z, { s: 1 + rand() * 0.7, r: rand() * 3 });
  }
  // (gates removed: the game is free-ride now)
  for (const z of [100, 160, 350, 400]) { place(map, 'flag', -34, z); place(map, 'flag', 34, z); }
  for (let z = 566; z < 700; z += 22) place(map, 'flag', chuteCenter(z) + 8, z);
  place(map, 'sign', 40, 420, { r: Math.PI });
  startArea(map, { z: 10, x: 0, width: 20 });
  finishArea(map, { z: 792, x: -6, w: 62 });
  pruneSteepProps(map);
  return map;
}

// ---------------- MAP 4: Cornice (black) ----------------
// Built around one jump and nothing else. Everything above the lip exists to set the approach
// speed, and everything below it exists to catch you.
//
// The landing is the part that matters. A take-off angle decides how long you are in the air,
// but it is the LANDING SLOPE that decides how hard you arrive: touch down on ground steeper
// than your flight path and you land along it, touch down on anything flatter and the whole of
// your fall speed goes into the snow at once. So the ramp under this is long, steep, and set to
// stay under the arc rather than to look dramatic.
function cornice() {
  const map = createMap({ id: 'cornice', name: 'Cornice', w: 112, h: 440, spacing: 2, slopeDeg: 24, h0: 0, difficulty: 'black' });
  map.description = 'A long run-in to one very big jump, then a fast tail with two smaller hits.';
  map.order = 4;
  const rand = rnd(91);
  const LIP = 300;

  const center = (z) => (
    z < 90 ? 0
      : z < 250 ? Math.sin(((z - 90) / 160) * Math.PI) * 13
        : z < 520 ? 0
          : Math.sin(((z - 520) / 150) * Math.PI) * 15);

  pitchProfile(map, (z) => (
    z < 26 ? 7
      : z < 80 ? 7 + ((z - 26) / 54) * 21                     // roll into the face
        : z < 196 ? 28                                        // steep: this is where the speed comes from
          : z < 258 ? 28 - ((z - 196) / 62) * 15              // stand it up for the run-in
            : z < 332 ? 13                                    // run-in stays FLAT past the lip crest
              : z < 374 ? 34                                  // the gap opens under the arc
                : z < 482 ? 41                                // landing, long enough for a hot approach
                  : z < 540 ? 41 - ((z - 482) / 58) * 21      // knuckle out
                    : z < 640 ? 20
                      : z < 760 ? 24
                        : z < 812 ? 16
                          : z < 852 ? 16 - ((z - 812) / 40) * 9
                            : 7), { smoothM: 8 });

  shapeValley(map, {
    floorHalf: (z) => (z < 70 ? 34 : z < 250 ? 20 : z < 540 ? 46 : 32),
    wallH: 12, wallRun: 32, pow: 1.9, outerGrade: 0.26, centerFn: center,
  });

  // Rollers on the upper face only. The run-in is left deliberately smooth: a bump in the last
  // fifty metres is the difference between leaving the lip flat and leaving it sideways.
  addRollers(map, { z0: 100, z1: 200, wavelength: 44, amp: 1.4 });
  addNoise(map, { amp: 0.65, scale: 0.02, oct: 4, seed: 5.1, mask: (x, z) => (z > 262 && z < 470 ? 0.15 : 1) });
  addNoise(map, { amp: 0.22, scale: 0.07, oct: 2, seed: 2.4, mask: (x, z) => (z > 262 && z < 470 ? 0.2 : 1) });

  // The lip. Wide enough that you do not have to thread it, and shallow-angled for its size --
  // a big ramp at a modest angle is far more forgiving than a small one that flicks you.
  kicker(map, 0, LIP, { radius: 19, height: 6.0 });
  // Shoulders, so the take-off reads as part of the mountain rather than a ramp dropped on it.
  kicker(map, -26, LIP - 3, { radius: 13, height: 2.2 });
  kicker(map, 26, LIP - 3, { radius: 13, height: 2.2 });

  // Two smaller hits down the tail, for when you want the air without the commitment.
  kicker(map, center(600), 600, { radius: 11, height: 2.1 });
  kicker(map, center(690), 690, { radius: 12, height: 2.4 });

  // Smooth the LANDING, and never the lip. A couple of passes across a take-off rounds off the
  // very edge you are trying to leave from, and a rounded lip is a roll-over rather than a jump.
  smoothAll(map, 2, (x, z) => (z > 344 && z < 528 ? 1 : 0));

  treeLine(map, rand, { side: -1, z0: 60, z1: 244, spacing: 10, inset: 20, insetVar: 10, cx: center });
  treeLine(map, rand, { side: 1, z0: 60, z1: 244, spacing: 10, inset: 20, insetVar: 10, cx: center });
  // Nothing at all within the landing: it is the one place on the map you cannot choose your line.
  glade(map, rand, { z0: 548, z1: 800, cx: center, halfWidth: 86, inner: 54, density: 0.005, minGap: 9, types: ['fir', 'pine'] });
  for (const [rx, rz] of [[-64, 372], [66, 402], [-68, 430], [62, 462]]) place(map, 'rock', rx, rz, { s: 1.5 + rand() * 0.5, r: rand() * 3 });

  // Flag the lip so it is visible from the top of the run-in, and the knuckle so you know where
  // the landing stops being a landing.
  for (const x of [-30, -22, 22, 30]) place(map, 'flag', x, LIP - 16);
  place(map, 'sign', -34, LIP - 26, { r: Math.PI });
  place(map, 'sign', 34, LIP - 26, { r: Math.PI });
  for (const x of [-40, 40]) for (let z = 400; z <= 520; z += 24) place(map, 'flag', x, z);

  // (gates removed: the game is free-ride now)
  finish(map, 852, 60);                      // the landing dumps you out wide, so the line is wide
  startArea(map, { z: 10, x: 0, width: 22 });
  finishArea(map, { z: 852, x: 0, w: 60 });
  pruneSteepProps(map);
  return map;
}

// ---------------- MAP 5: Spine Line (black) ----------------
// The inverse of every other map here: instead of a valley whose walls hold you in, a ridge
// whose sides fall away. Nothing catches a mistake, so the whole run is about staying on a line
// about as wide as a road.
function spineLine() {
  const map = createMap({ id: 'spine-line', name: 'Spine Line', w: 112, h: 470, spacing: 2, slopeDeg: 23, h0: 0, difficulty: 'black' });
  map.description = 'A knife-edge spine with both sides falling away, into a tight chute and a bowl.';
  map.order = 5;
  const rand = rnd(53);

  const spine = (z) => (
    z < 80 ? 0
      : z < 430 ? Math.sin(((z - 80) / 175) * Math.PI) * 22
        : z < 660 ? Math.sin(((z - 430) / 230) * Math.PI) * -16
          : 0);

  pitchProfile(map, (z) => (
    z < 26 ? 7
      : z < 74 ? 7 + ((z - 26) / 48) * 17
        : z < 430 ? 24                                         // the spine itself
          : z < 520 ? 30                                       // steepens into the chute
            : z < 660 ? 27                                     // chute
              : z < 760 ? 19                                   // bowl
                : z < 860 ? 13
                  : z < 904 ? 14 - ((z - 860) / 44) * 7
                    : 6), { smoothM: 16 });

  // A NEGATIVE wall height inverts shapeValley: the ground falls away from the centreline
  // instead of rising to it. That single sign is the whole character of this map.
  shapeValley(map, {
    floorHalf: (z) => (z < 70 ? 30 : z < 400 ? 9 : z < 440 ? 9 + ((z - 400) / 40) * 5 : z < 660 ? 11 : 40),
    wallH: (0), wallRun: 30, pow: 1.9, outerGrade: 0.0, centerFn: spine,
  });
  // the spine's fall-away, applied only where the spine actually runs
  {
    const { w, h } = map.size, sp = map.spacing;
    for (let z = 0; z < h; z++) {
      const wz = z * sp;
      if (wz < 70 || wz > 668) continue;
      const env = Math.min(1, (wz - 70) / 40, (668 - wz) / 40);
      const halfAt = wz < 400 ? 9 : wz < 440 ? 9 + ((wz - 400) / 40) * 5 : 11;
      for (let x = 0; x < w; x++) {
        const [wx] = gridToWorld(map, x, z);
        const d = Math.abs(wx - spine(wz)) - halfAt;
        if (d <= 0) continue;
        const t = Math.min(1, d / 26);
        let dy = -Math.pow(t, 1.7) * 15 * env;
        if (d > 26) dy -= (d - 26) * 0.30 * env;
        map.heights[z * w + x] += dy;
      }
    }
  }
  // and a rim beyond the fall-away, so the map edge is still unmistakable
  shapeValley(map, { floorHalf: 78, wallH: 16, wallRun: 24, pow: 1.6, outerGrade: 0.34 });
  // The bowl has to funnel. Left as a 40 m-wide floor it let riders drift out to the side and
  // finish past the end of the banner, which reads as the map being broken rather than as a
  // missed line. It narrows steadily from the chute exit down to the finish.
  shapeValley(map, {
    floorHalf: (z) => (z < 690 ? 90 : z < 900 ? 90 - ((z - 690) / 210) * 62 : 28),
    wallH: 7, wallRun: 26, pow: 1.7, outerGrade: 0.18,
  });

  addRollers(map, { z0: 110, z1: 400, wavelength: 52, amp: 1.1 });
  addCamber(map, { z0: 100, z1: 420, wavelength: 170, amp: 1.1, reach: 12, centerFn: spine });
  addNoise(map, { amp: 0.55, scale: 0.025, oct: 4, seed: 8.8 });
  addNoise(map, { amp: 0.2, scale: 0.08, oct: 2, seed: 1.7 });

  // moguls in the bowl, where there is finally room to make mistakes
  for (let row = 0; row * 9.5 < 100; row++) {
    const z = 676 + row * 9.5;
    for (let col = -5; col <= 5; col++) {
      const px = col * 6.5 + (row % 2 ? 3.2 : 0) + (rand() - 0.5) * 3;
      const pz = z + (rand() - 0.5) * 3;
      if (rand() < Math.max(0, (Math.abs(px) / 34 - 0.6) / 0.4)) continue;
      applyBrush(map, { tool: 'raise', x: px, z: pz, radius: 4.2 + rand() * 1.6, strength: 1, dt: 0.065 + rand() * 0.04, falloff: 0.05 });
    }
  }
  smoothAll(map, 1, (x, z) => (z > 430 && z < 670 ? 1 : 0));

  // Trees below the spine on both sides, so the drop reads as a drop rather than as open snow.
  glade(map, rand, { z0: 100, z1: 420, cx: spine, halfWidth: 74, inner: 34, density: 0.006, minGap: 8, types: ['fir', 'pine'] });
  glade(map, rand, { z0: 690, z1: 860, halfWidth: 82, inner: 52, density: 0.004, minGap: 10, types: ['fir', 'birch'] });
  for (let z = 100; z < 420; z += 19) {
    for (const side of [-1, 1]) place(map, rand() < 0.6 ? 'rock' : 'boulder', spine(z) + side * (16 + rand() * 6), z, { s: 0.9 + rand() * 0.6, r: rand() * 3 });
  }
  for (let z = 452; z < 640; z += 16) {
    for (const side of [-1, 1]) place(map, 'boulder', spine(z) + side * (17 + rand() * 5), z, { s: 1 + rand() * 0.6, r: rand() * 3 });
  }
  for (let z = 120; z < 420; z += 26) { place(map, 'flag', spine(z) - 7, z); place(map, 'flag', spine(z) + 7, z); }
  place(map, 'sign', 26, 86, { r: Math.PI });

  // (gates removed: the game is free-ride now)
  finish(map, 904, 64);                      // the bowl is still funnelling here
  startArea(map, { z: 10, x: 0, width: 20 });
  finishArea(map, { z: 904, x: 0, w: 64 });
  pruneSteepProps(map);
  return map;
}

// ---------------- MAP 6: Couloir (black) ----------------
// Narrow, steep and relentless. There is no wide line anywhere on it: the floor is barely two
// board-lengths across for most of the run, so every turn has to be finished.
function couloir() {
  const map = createMap({ id: 'couloir', name: 'Couloir', w: 96, h: 450, spacing: 2, slopeDeg: 26, h0: 0, difficulty: 'black' });
  map.description = 'A rock-walled chute that never opens up, with an ice band halfway and a sudden apron at the bottom.';
  map.order = 6;
  const rand = rnd(17);
  map.env = { ...map.env, snowType: 'ice', timeOfDay: 0.22, fog: 0.4 };

  const cx = (z) => (
    z < 70 ? 0
      : z < 300 ? Math.sin(((z - 70) / 115) * Math.PI) * 11
        : z < 560 ? Math.sin(((z - 300) / 130) * Math.PI) * -13
          : z < 720 ? Math.sin(((z - 560) / 160) * Math.PI) * 9
            : 0);

  pitchProfile(map, (z) => (
    z < 24 ? 7
      : z < 72 ? 7 + ((z - 24) / 48) * 20
        : z < 300 ? 27
          : z < 366 ? 33                                       // the ice band: steepest part
            : z < 560 ? 28
              : z < 700 ? 25
                : z < 770 ? 16                                 // the apron
                  : z < 836 ? 16 - ((z - 770) / 66) * 9
                    : 6), { smoothM: 14 });

  shapeValley(map, {
    floorHalf: (z) => (z < 64 ? 30 : z < 100 ? 30 - ((z - 64) / 36) * 16 : z < 690 ? 14 : z < 740 ? 14 + ((z - 690) / 50) * 32 : 46),
    wallH: 20, wallRun: 24, pow: 1.5, outerGrade: 0.42, centerFn: cx,
  });

  addRollers(map, { z0: 110, z1: 290, wavelength: 38, amp: 1.0 });
  addRollers(map, { z0: 380, z1: 550, wavelength: 34, amp: 0.9 });
  addNoise(map, { amp: 0.5, scale: 0.03, oct: 4, seed: 4.4, mask: (x, z) => (z > 300 && z < 366 ? 0.2 : 1) });
  addNoise(map, { amp: 0.18, scale: 0.09, oct: 2, seed: 9.1 });
  smoothAll(map, 2, (x, z) => (z > 296 && z < 372 ? 1 : 0));   // the ice band is scoured smooth

  // Rock walls the whole way down, close in. These are the couloir.
  for (let z = 96; z < 700; z += 9 + rand() * 5) {
    const c = cx(z), half = 14.5 + fbm(z * 0.06 + 3.1, 1.7, 2) * 1.6;
    for (const side of [-1, 1]) {
      place(map, rand() < 0.45 ? 'boulder' : 'rock', c + side * (half + 3 + rand() * 4), z, { s: 1 + rand() * 0.8, r: rand() * 3 });
      if (rand() < 0.4) place(map, 'rock', c + side * (half + 11 + rand() * 8), z + rand() * 5, { s: 1.3 + rand() * 0.7, r: rand() * 3 });
    }
  }
  glade(map, rand, { z0: 600, z1: 830, cx, halfWidth: 78, inner: 40, density: 0.005, minGap: 9, types: ['fir', 'pine'] });
  for (let z = 120; z < 680; z += 34) { place(map, 'flag', cx(z) - 11, z); place(map, 'flag', cx(z) + 11, z); }
  place(map, 'sign', 22, 80, { r: Math.PI });
  place(map, 'sign', -22, 296, { r: Math.PI });

  // (gates removed: the game is free-ride now)
  finish(map, 836, 78);                      // the apron fans out, and a hot exit fans out with it
  startArea(map, { z: 10, x: 0, width: 18 });
  finishArea(map, { z: 836, x: 0, w: 78 });
  pruneSteepProps(map);
  return map;
}

// A forest over a region rather than along a line, for a hill that has no centreline.
function forest(map, rand, { x0, x1, z0, z1, density = 0.004, types = ['pine', 'fir'], minGap = 9, keepOut = null, maxSlope = 34 }) {
  const placed = [];
  const n = Math.round((x1 - x0) * (z1 - z0) * density);
  for (let i = 0; i < n * 3 && placed.length < n; i++) {
    const x = x0 + rand() * (x1 - x0), z = z0 + rand() * (z1 - z0);
    if (keepOut && keepOut(x, z)) continue;
    if (slopeDegAt(map, x, z) > maxSlope) continue;
    let ok = true;
    for (const p of placed) if ((p[0] - x) ** 2 + (p[1] - z) ** 2 < minGap * minGap) { ok = false; break; }
    if (!ok) continue;
    placed.push([x, z]);
    place(map, types[Math.floor(rand() * types.length)], x, z, { s: 0.75 + rand() * 0.8, r: rand() * 6.28 });
  }
}

// ---------------- MAP 7: Alpine Bowl (open) ----------------
// A resort mountain, not a run. The whole thing is built in POLAR coordinates around one point --
// the village at the bottom -- so every face on it drains to the same place and you can drop in
// anywhere and end up at the lift. That is what a real resort does, and it is why a corridor map
// with walls either side always feels like a corridor no matter how you dress it.
//
// The spurs that divide the faces are placed by bearing and given a slow twist with height, so
// the fall line bends round as you descend instead of pointing at the village the whole way.
// Riding the middle of a face takes you somewhere different from where you were aiming, which is
// most of what makes a real mountain interesting to read.
function alpineBowl() {
  const map = createMap({ id: 'alpine-bowl', name: 'Alpine Bowl', w: 340, h: 340, spacing: 3, slopeDeg: 0, h0: 0, difficulty: 'black' });
  map.description = 'An open mountain. Four faces around one valley, a cirque, a gully, cliffs, a frozen tarn and a park, all draining to the village.';
  map.order = 0;
  map.freeride = true;
  map.env = { ...map.env, timeOfDay: 0.26, fog: 0.26, snowfall: 0.12, snowType: 'groomed', wind: 0.25 };
  const rand = rnd(7781);
  const { w, h } = map.size, sp = map.spacing;
  const BX = 0, BZ = 905;                      // the village: everything on the map runs to here

  // ---- the long profile, as a function of distance FROM the village ----
  // The apron used to be 3 degrees out to d = 60 and did not reach 22 until d = 150, and with the
  // run-out behind the village on top of that, EVERY descent ended with the same 164-176 m of
  // ground too flat to carry speed on -- measured from eight different drop-ins, all eight. The
  // last twenty seconds of every run were identical and slow. A village apron only has to be flat
  // enough to stand on at the lift queue, which is fifty metres, not two hundred.
  const grade = (d) => (
    d < 50 ? 6                                  // the village apron
      : d < 130 ? 6 + ((d - 50) / 80) * 17      // roll out of the base
        : d < 330 ? 25                          // lower faces
          : d < 400 ? 11                        // the mid bench: the tarn and the warming hut
            : d < 620 ? 27                      // the steep middle
              : d < 700 ? 20                    // second bench
                : d < 860 ? 28                  // upper faces
                  : d < 940 ? 12                // summit shoulder
                    : 5);                       // the ridge line itself
  const STEP = 4, NR = 300;
  const prof = new Float32Array(NR);
  { let y = 0; for (let k = 0; k < NR; k++) { prof[k] = y; y += deg(grade(k * STEP)) * STEP; } }
  const elev = (d) => {
    const u = Math.min(NR - 1.001, Math.max(0, d / STEP));
    const k = u | 0; return prof[k] + (prof[k + 1] - prof[k]) * (u - k);
  };

  // ---- the shape around the mountain ----
  // Four spurs by bearing, each twisting with height so the faces between them curve.
  const SPURS = [-1.24, -0.42, 0.40, 1.16];
  const twist = (d) => (d - 480) / 480 * 0.20;

  // ---- where you can get OFF the top ----
  // The rim below used to be a pure function of distance, which makes it a closed ring rather than
  // a rim: measured every on-map bearing from d = 905 down to d = 760 and not one of seventeen got
  // off the summit without crossing 55 degrees, minimum anywhere 55, worst 64. The Summit Express
  // unloaded you onto 52 degree ground above it and the start gate sat on 47. Segmenting the
  // CORNICE on top of that achieved nothing, because the wall underneath it was solid.
  //
  // So the rim's height is a function of bearing too. At these four bearings it opens into a
  // rollover you ride off; between them it stays the corniced headwall you look over. The couloir
  // cuts through at about -0.53 as a fifth, expert way down.
  // 0.36 and not the 0.62 that would balance them, because the axis leans 165 m east by the time
  // it reaches the rim and the on-map bearing range up there is only about -0.87 to +0.40: a ramp
  // at 0.62 would have been a drop-in 165 m past the edge of the world.
  const RAMPS = [-0.80, 0.06, 0.36];
  const rimGate = (th) => {
    let open = 0;
    for (const r of RAMPS) { const u = (th - r) / 0.13; open = Math.max(open, Math.exp(-u * u)); }
    return 1 - open;
  };
  // One unambiguous high point, on the shoulder between the centre and east drop-ins so it stands
  // against the sky both from the village and from the lift. Without it the mountain had no top:
  // its highest ground was the west edge of the MAP, 82 m above where the lift drops you.
  // It sits on the west-centre spur, halfway between two drop-ins rather than on top of one, and
  // at d = 880 rather than up on the plateau -- past about 900 on this bearing you are off the
  // north edge of the map, so a "summit" any further out would have been half a hill in the void.
  const PEAK = { d: 880, th: -0.37, h: 54, rd: 100, rth: 0.20 };
  // and a ceiling for everything that is not the peak, so no map corner can out-climb it again.
  // Fading the shoulders by z only ever moved that problem from one corner to the other.
  const CAP = () => elev(928) + 92, CAPSOFT = 30;
  // The valley AXIS leans across the hill as it climbs, so the mountain is not a cone. Everything
  // downstream reads distance from this moving axis rather than from the village, which is what
  // makes the fall line curve: the point you are falling toward keeps sliding sideways as you
  // descend. Rotating spur bearings alone cannot do this -- the spurs are not in the gradient.
  const VALLEY = 165;
  const axisAt = (d) => BX + VALLEY * Math.sin(Math.min(1.62, Math.max(0, (d - 210) / 430)));
  const polar = (wx, wz) => {
    const up = Math.max(BZ - wz, 0);
    const d0 = Math.hypot(wx - BX, up);          // one pass is plenty: the axis moves slowly
    const ax = axisAt(d0);
    const dx = wx - ax;
    const d = Math.hypot(dx, up);
    return { d, th: Math.atan2(dx, Math.max(up, 1e-3)), behind: BZ - wz < 0 ? wz - BZ : 0 };
  };
  const shape = (wx, wz) => {
    const { d, th, behind } = polar(wx, wz);
    let y = elev(d);
    // Spurs: ridges radiating from the summit, fading out before they reach the village so the
    // valley floor stays open where everything converges.
    const fade = smooth01((d - 150) / 140) * (1 - smooth01((d - 900) / 120));
    for (let i = 0; i < SPURS.length; i++) {
      let a = th - (SPURS[i] + twist(d));
      while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2;
      const wgt = a / (0.20 + 0.00016 * d);
      y += Math.exp(-wgt * wgt) * (16 + d * 0.030) * fade;
    }
    // Relief that is NOT a function of (d, th). Everything else on this mountain is authored in
    // polar coordinates around the village, and it measured exactly as that sounds: 99.4% of the
    // height was a 1-D function of distance from the base, the residual averaged 9.3 m on a 490 m
    // mountain, and across the whole lower third -- the village approach, the most-ridden ground
    // on the map -- nothing departed from a perfect cone by more than 2.4 m. Rings of features on
    // a cone still ride like a cone.
    //
    // The noise is deliberately ANISOTROPIC: short wavelength across the hill, long wavelength
    // down it. That is the difference between relief and damage. Ribs and hollows that run with
    // the fall line give you spurs to ride between and lines to choose, while the gradient ALONG
    // the fall line barely changes, so the drainage that took two rounds to get right survives.
    // Isotropic noise at this amplitude would have been 26 degrees of local gradient against a
    // 25 degree face, which reverses the flow and ponds it.
    const rel = smooth01((d - 150) / 160) * (1 - smooth01((d - 800) / 140))
              * (1 - 0.45 * smooth01((Math.abs(th) - 0.55) / 0.60));
    if (rel > 0) {
      y += fbm(wx * 0.0052 + 13.7, wz * 0.0019 + 5.1, 2) * 21 * rel;
      y += fbm(wx * 0.0115 + 2.3, wz * 0.0042 + 9.8, 2) * 7 * rel;
    }
    // The cirque rim -- but gated by bearing (see RAMPS above). Full height between the ramps,
    // where it is a headwall with a cornice on it; a third of that at a ramp, where the same
    // 120 m carries about 12 degrees of extra grade and you simply ride off the top.
    const gate = rimGate(th);
    y += smooth01((d - 790) / 80) * (16 + 42 * gate);
    y += smooth01((d - 870) / 60) * (12 + 34 * gate);
    // Behind the village the valley keeps running out, and its sides rise -- gently, and eased in
    // over 130 m. Switching this on with no blend put a 762 m wide, 88 degree wall straight across
    // the map at z = 906 and dropped the finish into a 315 m deep slot.
    //
    // The fall along it matters as much as the sides: 0.075 is 4.3 degrees, and at mu = 0.034
    // that is inside the band where you are decelerating -- it was the second half of the dead
    // flat that ended every single run. 0.16 is 9 degrees: still an obvious valley floor you can
    // stand on, but one you arrive at the bottom of still moving.
    if (behind > 0) {
      const b = smooth01(behind / 130);
      y += (Math.pow(Math.abs(wx) / 340, 2) * 10 - behind * 0.16) * b;
    }
    // Far shoulders, so the map edge is a mountainside and not a wall. They used to start biting
    // at |x| = 355 with a squared ramp to 74 m, which walled off 150 m of each side: the west
    // flank measured 38-42 degrees for its entire length and only 288 m of the map's 1017 m width
    // was under 15 degrees at the base. Pushed outward and cut to 48 m, they still close the view
    // without eating a third of the rideable mountain.
    y += Math.pow(Math.max(0, Math.abs(wx) - 400) / 170, 2) * 48 * smooth01((wz - 180) / 180);
    // Roll everything off as it approaches the ceiling, so no corner of the map can out-climb the
    // summit. Exponential rather than a clamp, because a clamp is a crease you can see.
    const over = y - (CAP() - CAPSOFT);
    if (over > 0) y = CAP() - CAPSOFT + CAPSOFT * (1 - Math.exp(-over / CAPSOFT));
    // The peak is added AFTER the ceiling, because it is the thing the ceiling exists to protect.
    { const u = (d - PEAK.d) / PEAK.rd, v = (th - PEAK.th) / PEAK.rth; y += Math.exp(-(u * u + v * v)) * PEAK.h; }
    return y;
  };

  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const [wx, wz] = gridToWorld(map, x, z);
    map.heights[z * w + x] = shape(wx, wz);
  }
  // heights above are "how far above the village", so flip into world elevation
  for (let i = 0; i < map.heights.length; i++) map.heights[i] = map.heights[i] - 0;

  addNoise(map, { amp: 3.0, scale: 0.0045, oct: 4, seed: 2.7 });
  addNoise(map, { amp: 1.0, scale: 0.018, oct: 3, seed: 6.1 });
  addNoise(map, { amp: 0.28, scale: 0.07, oct: 2, seed: 9.4 });

  // ---------------- places worth going ----------------
  // The inverse of polar(), and it has to invert the SAME thing. Leaving this on the fixed origin
  // after the axis started moving put every feature placed by bearing tens of metres from where
  // its bearing said it was -- and the cat track, which reads a height back through it, was
  // cutting its bench to a target taken from the wrong hillside: a 27 m step across the east face.
  const atPolar = (d, th) => [axisAt(d) + Math.sin(th) * d, BZ - Math.cos(th) * d];

  // 1. THE GULLY -- a natural halfpipe down the west face, between the two west spurs.
  {
    const cx = (wz) => { const up = BZ - wz; return axisAt(up) + Math.sin(-0.62 + twist(up) * 0.8) * up * 0.92; };
    for (let z = 0; z < h; z++) {
      const wz = z * sp, d = BZ - wz;
      if (d < 180 || d > 700) continue;
      const env = Math.min(1, (d - 180) / 90, (700 - d) / 110);
      const c = cx(wz);
      // The hillside falls away east faster than a fixed 11 m wall can rise, so east of the trough
      // the "wall" measured NEGATIVE -- between 0.2 and 14.9 m below the floor at z = 550 and
      // z = 700 -- which makes it a one-walled ditch, not a halfpipe. The downhill wall carries the
      // local cross-fall on top of its own height, so both sides stand up wherever it is cut.
      const y0 = shape(c, wz);
      for (let x = 0; x < w; x++) {
        const [wx] = gridToWorld(map, x, z);
        const a = Math.abs(wx - c);
        if (a > 42) continue;
        // A halfpipe is a CROSS-SECTION, not a bump. Adding a fixed lump either side meant the
        // downhill wall had to fight the hillside falling away beneath it: east of the trough the
        // "wall" measured up to 14.9 m BELOW the floor, so it rode as a one-walled ditch. Making
        // the lump taller by the local cross-fall fixed that and produced a 78 degree cliff
        // instead. Blending toward a profile measured from the centreline gives both walls the
        // same height above the same floor whatever the hill underneath is doing.
        const prof = -9 * Math.exp(-Math.pow(a / 13, 2)) + 10 * Math.exp(-Math.pow((a - 17) / 10, 2));
        const k = (1 - smooth01((a - 26) / 16)) * env;
        map.heights[z * w + x] += ((y0 + prof) - map.heights[z * w + x]) * k;
      }
    }
  }

  // 2. THE CLIFF BAND -- across the east face, with a rounded chicken line off its south end.
  {
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const { d, th } = polar(wx, wz);
      if (th < 0.1 || th > 1.15) continue;
      const band = 560 + fbm(th * 3.1 + 4.4, 1.9, 3) * 26;
      const drop = 11 * (1 - smooth01((Math.abs(th - 0.62) - 0.22) / 0.20));
      if (drop < 0.05) continue;
      // A cliff drops the ground below it and the ground STAYS down -- that is what a cliff is.
      // What it must not do is either carry the step all the way to the village (which gouged a
      // 7.7 m crater through the base area) or recover it quickly (which builds a 14 m dam a
      // hundred metres below the face and ponds the whole east flank). So: full drop for 250 m,
      // then eased out over another 200, which is a third of a degree of extra grade.
      const below = band - d;
      map.heights[z * w + x] -= drop * smooth01(below / 14) * (1 - smooth01((below - 250) / 200));
    }
  }

  // 3. THE TARN -- a frozen lake on the mid bench, flat and unmistakable from above.
  {
    const [lx, lz] = atPolar(360, -0.30);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const r = Math.hypot((wx - lx) / 58, (wz - lz) / 40);
      if (r > 3.0) continue;
      // Blended over a very wide margin on purpose. A lake is a flat disc, and the ground round
      // it is on a 31 degree pitch: punch it in with a short taper and the uphill rim becomes a
      // 24 m headwall at 87 degrees, which is neither rideable nor anything a tarn looks like.
      // Spread over three radii it reads as the basin the water sat in.
      const k = 1 - smooth01((r - 0.85) / 2.0);
      // Tilted 2.6 degrees down-valley rather than level. A dead flat 116 m disc on a mountain
      // where you need about 2 degrees just to overcome friction is somewhere you glide onto and
      // stop, and the steepest-descent tracer simply circled on it forever. 2.6 degrees measured
      // out at 2 once the blend and the noise had their say, which is break-even and no use; at
      // 4.5 it still reads as the flat pan of a lake beside a 27 degree face, and you cross it.
      const target = shape(lx, lz) - 1.4 - (wz - lz) * deg(4.5);
      map.heights[z * w + x] += (target - map.heights[z * w + x]) * k;
    }
    map.tarn = { x: lx, z: lz };
    // and mark it as ice so the renderer colours it -- a flat white patch is not a lake
    map.ice = [{ x: lx, z: lz, rx: 60, rz: 42 }];
  }

  // 4. THE PARK -- a line of hits down the mellow rib just east of the village.
  {
    // Small to large as you go DOWN, so the line builds. Flatten the ground under each lip first:
    // a kicker added to a rolling slope is only a kicker if what it sits on is not already a dip.
    for (let i = 0; i < 6; i++) {
      const d = 330 - i * 40, th = 0.30;
      const [kx, kz] = atPolar(d, th + twist(d));
      applyBrush(map, { tool: 'smooth', x: kx, z: kz - 6, radius: 26, strength: 1, dt: 1.0, falloff: 0.5 });
      kicker(map, kx, kz, { radius: 10 + i * 1.5, height: 1.9 + i * 0.55 });
    }
  }

  // 5. THE COULOIR -- a narrow slot through the west headwall, for people who want it.
  {
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const { d, th } = polar(wx, wz);
      if (d < 620 || d > 880) continue;
      const c = -0.70 + twist(d);
      const a = Math.abs(th - c) / 0.055;
      if (a > 5) continue;                 // walls only, not the whole annulus
      const env = Math.min(1, (d - 620) / 60, (880 - d) / 60);
      // a slot: the floor drops, the walls stand either side of it, and both fade out by a=5
      const wall = Math.min(1, Math.max(0, (a - 1) / 1.6)) * (1 - smooth01((a - 2.6) / 2.4));
      map.heights[z * w + x] += (wall * 22 - (1 - Math.min(1, a)) * 5) * env;
    }
  }

  // 6a. THE TOP OF THE MOUNTAIN. Everything above d = 650 -- a quarter of the map, and the first
  //     two hundred metres of every single descent -- was blank white snow with four signs on it.
  //     Measured, you rode 405 m from the start gate before passing anything at all.
  {
    // A cornice along the rim, in broken segments so there is always a way round it and always a
    // way off it. This is the first thing you meet coming off the lift.
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const { d, th } = polar(wx, wz);
      if (d < 790 || d > 900) continue;
      // Broken into segments by its own sine AND held off the drop-in ramps. Gapping it on its
      // own phase was never enough: the phase happened to be near its peak at the centre ramp, so
      // the cornice quietly rebuilt the headwall the rim had just opened, and the Summit Express
      // still unloaded you above 55 degrees of it.
      const seg = Math.sin(th * 4.6 + 0.7) * rimGate(th);
      if (seg < 0.08) continue;
      const lip = 852 + fbm(th * 4.2 + 2.2, 3.3, 3) * 14;
      const amt = Math.min(1, (seg - 0.08) / 0.5) * (5.5 + fbm(th * 2.7, 1.1, 2) * 3.5);
      map.heights[z * w + x] += amt * smooth01((d - lip) / 9);       // build the lip up
      map.heights[z * w + x] -= amt * 0.55 * (1 - smooth01((lip - d) / 20)) * smooth01((lip - d) / 4);
    }
    // A knoll off the west shoulder: a high point that is not the summit, so the skyline has
    // something in it other than one ridge.
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const { d, th } = polar(wx, wz);
      // Moved west from -0.86 and narrowed: it used to sit squarely on what is now the west
      // drop-in ramp, and a 34 m knoll in a ramp is not a knoll, it is the headwall again.
      const u = (d - 790) / 90, v = (th + 1.05) / 0.20;
      map.heights[z * w + x] += Math.exp(-(u * u + v * v)) * 34;
    }
    // An upper bowl scooped into the east face, with a rim on its downhill side you drop over.
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const { d, th } = polar(wx, wz);
      // Pulled in from 0.56. The valley axis leans 165 m east by the top, so a bearing that is
      // comfortably on the map low down walks off the edge higher up: at 0.56 the bowl's centre
      // was at x = 562 and only 41% of it was on the map at all, along with all eight of its
      // flags. At 0.30 the whole feature is on the hill, and it is 240 m from the lift instead
      // of 420, which gives the Summit Express something to aim at.
      const u = (d - 760) / 95, v = (th - 0.30) / 0.30;
      const g = Math.exp(-(u * u + v * v));
      map.heights[z * w + x] -= g * 15;
    }
    // Wind ribs: shallow radial ridges the wind leaves on an exposed upper face. They run WITH
    // the fall line, so they are something to ride between rather than something to cross.
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const { d, th } = polar(wx, wz);
      if (d < 620 || d > 860) continue;
      const env = Math.min(1, (d - 620) / 70, (860 - d) / 60);
      map.heights[z * w + x] += Math.sin(th * 17.0 + 0.4) * 1.5 * env;
    }
    // and two natural hits on the way down off the summit
    for (const [kd, kth, kr, kh] of [[720, -0.30, 13, 2.8], [690, 0.16, 15, 3.2]]) {
      const [kx, kz] = atPolar(kd, kth + twist(kd));
      applyBrush(map, { tool: 'smooth', x: kx, z: kz - 6, radius: 26, strength: 1, dt: 1.0, falloff: 0.5 });
      kicker(map, kx, kz, { radius: kr, height: kh });
    }
  }

  // 6. MOGULS on the lower middle face, and rollers on the upper west.
  for (let row = 0; row * 10 < 160; row++) {
    const d = 190 + row * 10;
    for (let col = -7; col <= 7; col++) {
      const th = -0.06 + col * 0.055 + (row % 2 ? 0.027 : 0);
      const [px, pz] = atPolar(d, th + twist(d));
      if (rand() < 0.22) continue;
      applyBrush(map, { tool: 'raise', x: px + (rand() - 0.5) * 4, z: pz + (rand() - 0.5) * 4, radius: 5.4 + rand() * 2.0, strength: 1, dt: 0.055 + rand() * 0.03, falloff: 0.14 });
    }
  }
  // Rollers at constant DISTANCE, so they lie across the fall line everywhere on a bowl instead
  // of only on the centreline.
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const [wx, wz] = gridToWorld(map, x, z);
    const { d } = polar(wx, wz);
    if (d < 170 || d > 520) continue;
    const env = Math.min(1, (d - 170) / 60, (520 - d) / 70);
    const { th: rth } = polar(wx, wz);
    const phase = (d - 170) + Math.sin(rth * 2.7) * 74 + Math.sin(rth * 5.1 + 1.3) * 26;
    // Left running across the cat track on purpose. Clearing a corridor through them measured
    // worse, not better: the rollers are what break a traverse line up, and with the corridor
    // planed smooth four of eight descents stopped descending and followed the bench instead.
    map.heights[z * w + x] += (Math.sin(phase / 52 * Math.PI * 2) * 0.5 + 0.5) * 1.25 * env;
  }

  // 7. A CAT TRACK cut across the mountain, linking the faces at the mid bench. Flat, obvious,
  //    and the thing that makes a mountain feel like somewhere people go rather than a shape.
  {
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const { d, th } = polar(wx, wz);
      if (th < -1.35 || th > 1.30) continue;
      const line = 430 - th * 42;
      const off = Math.abs(d - line);
      if (off > 12) continue;
      // Tapered at BOTH ENDS of its bearing range as well as across its width. Stopping the cut
      // dead at th = -1.35 left the bench's west end as a 6.2 m hole in the hillside at (-400, 798).
      const ends = smooth01((th + 1.35) / 0.24) * (1 - smooth01((th - 1.06) / 0.24));
      const k = (1 - smooth01((off - 5) / 7)) * ends;
      // ANCHORED AT ITS OWN DOWNHILL LIP. Three rounds of this have now shown the same thing from
      // three directions: a bench whose floor sits below the natural ground at its downhill edge is
      // a dam, and it does not matter how it got there. Filling the outside built an 8 m lip that
      // ringed the mountain and every fall line drained into. Cutting to a smoothed survey line
      // cut 40 m into the middle of the hill behind a 58 m, 81 degree bank. Bounding that cut to
      // 7 m left a 7 m trench that three of eight descents settled into and followed for three
      // kilometres. Tied to the lip it cannot be any of them: the surface meets the hillside
      // exactly where the bench ends, so there is never a step up to leave it by, and the 4 degrees
      // of outslope across the whole width means it is never level either. What is left above the
      // track is a cut bank you drop in off, which is what a cat track looks like anyway.
      const dLo = line - 12;
      const target = shape(...atPolar(dLo, th)) + Math.max(0, d - dLo) * deg(6);
      if (map.heights[z * w + x] > target) map.heights[z * w + x] += (target - map.heights[z * w + x]) * k;
    }
  }

  // 8. PLACES THAT ARE NOT ON THE POLAR GRID.
  //    Everything above this point is authored in (d, th) around the village, which is exactly why
  //    it all came out as rings and radii, and why 59% of the hill measured more than 150 m from
  //    anything worth riding to. The voids were not scattered: they were the entire lower-outer
  //    ring (z 700-1000, |x| 250-500, which is where you spend the last third of every descent)
  //    and the upper-centre band. These sit at the measured centres of the biggest empty blocks,
  //    and they are shapes you ride rather than scenery you pass.
  const bump = (cx2, cz2, rx, rz, amt) => {
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      const u = (wx - cx2) / rx, v = (wz - cz2) / rz, r2 = u * u + v * v;
      if (r2 > 6) continue;
      map.heights[z * w + x] += Math.exp(-r2) * amt;
    }
  };
  bump(-306, 818, 64, 50, 12);                       // THE KNOB: a treed rise on the lower west
  bump(332, 776, 27, 80, 15);                        // THE RIB, lower east, and the hollow beside
  bump(292, 778, 19, 80, -5.5);                      //   it, which together make a wall to carve
  bump(150, 302, 74, 15, 5.5);                       // THE WIND LIP: a lip across the upper face
  bump(150, 326, 66, 26, -2.2);                      //   with its landing cut in below
  bump(-404, 706, 52, 60, 9);                        // two more rises to break up the outer ring
  bump(408, 694, 50, 58, 8);
  // A shelf for the mid-mountain huts, cut not filled, so it cannot dam the face above it.
  applyBrush(map, { tool: 'smooth', x: 306, z: 340, radius: 46, strength: 1, dt: 1.0, falloff: 0.5 });

  smoothAll(map, 1, (x, z) => { const { d } = polar(x, z); return d < 110 ? 1 : 0; });   // village apron, and only the apron

  // ---------------- lifts ----------------
  // Both tops land on a drop-in ramp, and both now unload within sight of what they are named
  // for. The West Bowl Chair used to stop at d = 660, which is 40 m from the BOTTOM of the
  // couloir -- you could not ride the couloir from the only lift on that side of the mountain
  // without hiking 176 vertical metres first.
  const [t1x, t1z] = atPolar(888, 0.06);
  const [t2x, t2z] = atPolar(858, -0.80);
  map.lifts = [
    { id: 'summit', name: 'Summit Express', base: { x: 46, z: BZ - 26 }, top: { x: t1x, z: t1z } },
    { id: 'west', name: 'West Bowl Chair', base: { x: -96, z: BZ - 34 }, top: { x: t2x, z: t2z } },
  ];

  // ---------------- dressing ----------------
  const onCatTrack = (x, z) => { const { d, th } = polar(x, z); return Math.abs(d - (430 - th * 42)) < 20; };
  const inTarn = (x, z) => Math.hypot((x - map.tarn.x) / 66, (z - map.tarn.z) / 48) < 1.2;
  const keep = (x, z) => onCatTrack(x, z) || inTarn(x, z);

  // Tree islands inside the open faces, not just a fringe round the edge: something to weave
  // through, and something to judge your speed against on a white slope.
  for (const [d, th, rx, rz, n] of [[250, -0.70, 70, 50, 0.010], [330, 0.62, 62, 44, 0.011],
                                    [480, -0.16, 54, 40, 0.009], [560, -0.95, 58, 42, 0.010],
                                    [620, 0.30, 50, 36, 0.009], [200, 0.85, 66, 46, 0.011]]) {
    const [cx, cz] = atPolar(d, th + twist(d));
    forest(map, rand, { x0: cx - rx, x1: cx + rx, z0: cz - rz, z1: cz + rz, density: n, minGap: 10,
      types: ['fir', 'pine', 'pine'], keepOut: (x, z) => keep(x, z) || Math.hypot((x - cx) / rx, (z - cz) / rz) > 1 });
  }
  // the treeline round the whole bowl
  forest(map, rand, { x0: -500, x1: 500, z0: 500, z1: 1010, density: 0.0016, minGap: 13, types: ['fir', 'pine', 'birch'],
    keepOut: (x, z) => { const { d } = polar(x, z); return d < 210 || keep(x, z); } });
  forest(map, rand, { x0: -500, x1: -300, z0: 180, z1: 700, density: 0.0018, minGap: 12, types: ['fir', 'pine'], keepOut: keep });
  forest(map, rand, { x0: 300, x1: 500, z0: 180, z1: 700, density: 0.0018, minGap: 12, types: ['fir', 'pine'], keepOut: keep });

  // rock along the spur crests and under the cliff band
  for (let d = 200; d < 880; d += 26) {
    for (const base of SPURS) {
      const th = base + twist(d) + (rand() - 0.5) * 0.06;
      const [rx2, rz2] = atPolar(d, th);
      if (rand() < 0.45) place(map, rand() < 0.5 ? 'rock' : 'boulder', rx2, rz2, { s: 1 + rand() * 0.9, r: rand() * 3 });
    }
  }
  for (let i = 0; i < 34; i++) {
    const [rx2, rz2] = atPolar(548 + rand() * 30, 0.44 + rand() * 0.44);
    place(map, rand() < 0.6 ? 'rock' : 'boulder', rx2, rz2, { s: 1.2 + rand() * 0.9, r: rand() * 3 });
  }
  for (let i = 0; i < 22; i++) {           // couloir walls
    const d = 630 + rand() * 240, side = rand() < 0.5 ? -1 : 1;
    const [rx2, rz2] = atPolar(d, -0.70 + twist(d) + side * 0.075);
    place(map, 'boulder', rx2, rz2, { s: 1.1 + rand() * 0.8, r: rand() * 3 });
  }

  // dressing for the places placed by coordinate above
  forest(map, rand, { x0: -372, x1: -240, z0: 772, z1: 866, density: 0.013, minGap: 9, types: ['fir', 'fir', 'pine'],
    keepOut: (x, z) => keep(x, z) || Math.hypot((x + 306) / 66, (z - 818) / 52) > 1 });
  for (let i = 0; i < 9; i++) place(map, rand() < 0.5 ? 'rock' : 'boulder', -306 + (rand() - 0.5) * 120, 818 + (rand() - 0.5) * 96, { s: 1 + rand() * 0.8, r: rand() * 3 });
  for (let i = 0; i < 16; i++) place(map, rand() < 0.35 ? 'rock' : 'boulder', 332 + (rand() - 0.5) * 46, 776 + (rand() - 0.5) * 150, { s: 1.2 + rand() * 1.0, r: rand() * 3 });
  for (let i = 0; i < 14; i++) place(map, rand() < 0.5 ? 'rock' : 'boulder', 150 + (rand() - 0.5) * 170, 338 + rand() * 46, { s: 1.1 + rand() * 0.9, r: rand() * 3 });
  { place(map, 'sign', 150, 292, { r: Math.PI }); place(map, 'flag', 108, 298); place(map, 'flag', 192, 298); }
  // a hamlet on the east shoulder: the upper-centre band had nothing in it at all
  { place(map, 'hut', 306, 340, { r: -0.4, s: 1.3 }); place(map, 'hut', 336, 356, { r: 0.6, s: 1.0 });
    place(map, 'lamp', 318, 330); place(map, 'lamp', 292, 352); place(map, 'sign', 282, 326, { r: Math.PI });
    for (let i = 0; i < 6; i++) place(map, 'flag', 268 + i * 16, 366 + (i % 2) * 6); }
  for (const [fx, fz, fr] of [[-404, 706, 56], [408, 694, 54]]) {
    forest(map, rand, { x0: fx - fr, x1: fx + fr, z0: fz - fr, z1: fz + fr, density: 0.010, minGap: 10, types: ['fir', 'pine'],
      keepOut: (x, z) => keep(x, z) || Math.hypot(x - fx, z - fz) > fr });
    for (let i = 0; i < 7; i++) place(map, rand() < 0.5 ? 'rock' : 'boulder', fx + (rand() - 0.5) * 110, fz + (rand() - 0.5) * 110, { s: 1 + rand() * 0.9, r: rand() * 3 });
  }
  // and the outer ring low down, where the last third of every descent happens
  for (const [fx, fz] of [[-348, 892], [352, 884], [-256, 952], [268, 946]]) {
    forest(map, rand, { x0: fx - 58, x1: fx + 58, z0: fz - 44, z1: fz + 44, density: 0.009, minGap: 10, types: ['fir', 'pine', 'birch'],
      keepOut: (x, z) => keep(x, z) || Math.hypot((x - fx) / 58, (z - fz) / 44) > 1 });
    for (let i = 0; i < 5; i++) place(map, rand() < 0.5 ? 'rock' : 'boulder', fx + (rand() - 0.5) * 100, fz + (rand() - 0.5) * 78, { s: 1 + rand() * 0.8, r: rand() * 3 });
  }

  // the village, and the places people would actually put things
  place(map, 'hut', -46, BZ + 26, { r: 0.35, s: 1.6 });
  place(map, 'hut', -84, BZ + 44, { r: 0.9, s: 1.2 });
  place(map, 'hut', 62, BZ + 40, { r: -0.5, s: 1.3 });
  for (let i = 0; i < 8; i++) place(map, 'lamp', -110 + i * 32, BZ + 16);
  for (let i = 0; i < 12; i++) place(map, 'flag', -132 + i * 24, BZ - 4 + (i % 2) * 7);
  place(map, 'snowman', -8, BZ + 8); place(map, 'snowman', -1, BZ + 13, { s: 0.8 });
  place(map, 'sign', 30, BZ - 40, { r: Math.PI });
  // a warming hut on the mid bench, beside the cat track
  { const [hx, hz] = atPolar(418, 0.06); place(map, 'hut', hx, hz, { r: 0.3, s: 1.1 }); place(map, 'lamp', hx + 9, hz + 4); place(map, 'sign', hx - 11, hz - 6, { r: Math.PI }); }
  // the summit: a rocky rim, cairns and a ridge you can walk the length of
  for (let i = 0; i < 46; i++) {
    const th = -1.35 + rand() * 2.7, d = 862 + rand() * 46;
    const [rx2, rz2] = atPolar(d, th);
    place(map, rand() < 0.55 ? 'rock' : 'boulder', rx2, rz2, { s: 1.2 + rand() * 1.1, r: rand() * 3 });
  }
  for (let i = 0; i < 16; i++) {          // outcrops scattered over the upper faces
    const th = -1.2 + rand() * 2.4, d = 660 + rand() * 180;
    const [rx2, rz2] = atPolar(d, th);
    place(map, 'boulder', rx2, rz2, { s: 1.4 + rand() * 1.0, r: rand() * 3 });
  }
  { const [kx, kz] = atPolar(800, -1.05); place(map, 'sign', kx, kz, { r: Math.PI }); place(map, 'flag', kx + 10, kz + 6); }
  { const [bx2, bz2] = atPolar(742, 0.30); for (let i = 0; i < 8; i++) { const t = i / 8 * Math.PI * 2; place(map, 'flag', bx2 + Math.cos(t) * 52, bz2 + Math.sin(t) * 40); } }
  // an upper treeline, so the top is not bare to the rim
  forest(map, rand, { x0: -420, x1: 420, z0: 140, z1: 330, density: 0.0011, minGap: 16, types: ['fir', 'fir', 'pine'],
    keepOut: (x, z) => { const { d } = polar(x, z); return d > 830 || keep(x, z); } });

  // markers at the top of each face
  for (const [d, th, lbl] of [[840, -1.05], [850, -0.46], [860, 0.10], [840, 0.66]]) {
    const [fx, fz] = atPolar(d, th + twist(d));
    place(map, 'sign', fx, fz, { r: Math.PI }); place(map, 'flag', fx + 8, fz + 5); place(map, 'flag', fx - 8, fz + 5);
  }
  // fences marking the tarn, so nobody rides into it wondering what it was
  { const a = map.tarn; for (let i = 0; i < 10; i++) { const t = (i / 10) * Math.PI * 2; place(map, 'flag', a.x + Math.cos(t) * 62, a.z + Math.sin(t) * 44); } }

  // The ways off the top, in world coordinates, so the harness can verify each one is rideable
  // and the signs below stand where they actually are.
  map.dropIns = RAMPS.map((th) => { const [x, z] = atPolar(872, th); return { x: +x.toFixed(1), z: +z.toFixed(1) }; });
  for (const p of map.dropIns) { place(map, 'sign', p.x, p.z, { r: Math.PI }); place(map, 'flag', p.x + 11, p.z + 7); place(map, 'flag', p.x - 11, p.z + 7); }

  map.start = { x: t1x + 14, z: t1z + 26, yaw: 0 };
  finish(map, (h - 4) * sp, 40);
  pruneSteepProps(map, 34);
  return map;
}

const maps = [alpineBowl(), firstTracks(), gladeRun(), ridgeLine(), cornice(), spineLine(), couloir()];
for (const m of maps) {
  fs.writeFileSync(path.join(MAPS, `${m.id}.json`), JSON.stringify(serializeMap(m)));
  const s = mapStats(m);
  console.log(`${m.id}: ${s.lengthM}m x ${s.widthM}m, drop ${s.verticalDropM.toFixed(0)}m, avg ${s.avgGradeDeg.toFixed(1)} deg, max ${s.maxSlopeDeg.toFixed(0)} deg, steep ${s.steepPct.toFixed(1)}%, props ${s.props}, gates ${s.gates}`);
}
const statePath = path.join(MAPS, '_state.json');
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify({ activeMap: 'first-tracks' }, null, 2));
