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
// Not a run. A square kilometre of mountain with a summit ridge, three faces separated by two
// spurs, a gully cut down the west side and a base area at the bottom, plus two chairlifts so you
// can get back up without anyone teleporting you. There are no gates, no finish line and no
// clock: the whole point is that you pick a line and go, and then pick a different one.
function alpineBowl() {
  const map = createMap({ id: 'alpine-bowl', name: 'Alpine Bowl', w: 340, h: 340, spacing: 3, slopeDeg: 0, h0: 0, difficulty: 'black' });
  map.description = 'An open mountain. Three faces off one summit ridge, a gully, cliffs, and two chairlifts to get back up.';
  map.order = 0;
  map.freeride = true;
  map.env = { ...map.env, timeOfDay: 0.28, fog: 0.3, snowfall: 0.15, snowType: 'groomed', wind: 0.25 };
  const rand = rnd(2024);
  const { w, h } = map.size, sp = map.spacing;
  const SPAN = (h - 1) * sp;                  // 1017 m from the summit ridge to the back of the base

  // The long profile, integrated from a grade the same way a single run is, so the mountain
  // steepens and eases the way a real one does instead of being a uniform ramp.
  const grade = (z) => (
    z < 50 ? 5                                 // the summit shoulder you step off the lift onto
      : z < 140 ? 5 + ((z - 50) / 90) * 27
        : z < 400 ? 32                         // the upper faces: this is the steep part
          : z < 470 ? 32 - ((z - 400) / 70) * 14
            : z < 520 ? 18                     // a bench across the middle of the hill
              : z < 760 ? 27                   // lower faces
                : z < 860 ? 27 - ((z - 760) / 100) * 15
                  : z < 940 ? 12
                    : 5);                      // the base area
  const prof = new Float32Array(h);
  { let y = 330; for (let z = 0; z < h; z++) { prof[z] = y; y -= deg(grade(z * sp)) * sp; } }
  const centre = (wz) => prof[Math.min(h - 1, Math.max(0, Math.round(wz / sp)))];

  // Two spurs running down the hill split it into three faces. Between them the ground dishes out
  // into bowls, so each face has its own shape rather than all of them being the same plane.
  const spur = (wx, wz, at, width, height) => {
    const fadeZ = Math.min(1, Math.max(0, (wz - 70) / 90)) * (1 - smooth01((wz - 700) / 180));
    const d = (wx - at) / width;
    return Math.exp(-d * d) * height * fadeZ;
  };
  const gully = (wx, wz) => {
    // A cut down the west side, deep enough in the middle to ride like a natural halfpipe.
    if (wz < 150 || wz > 800) return 0;
    const cx = -250 + Math.sin((wz - 150) / 210) * 26;
    const env = Math.min(1, (wz - 150) / 70, (800 - wz) / 90);
    const d = Math.abs(wx - cx) / 34;
    return -Math.exp(-d * d) * 17 * env;
  };

  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const [wx, wz] = gridToWorld(map, x, z);
      let y = centre(wz);
      // the hill dishes across its width, so the middle of each face is the natural line
      y += Math.pow(Math.abs(wx) / 500, 2.1) * 70;
      y += spur(wx, wz, -150, 62, 30) + spur(wx, wz, 160, 58, 26);
      y += gully(wx, wz);
      // and the summit ridge itself stands above everything behind it
      y += smooth01((70 - wz) / 70) * (28 + Math.abs(wx) * 0.05);
      map.heights[z * w + x] = y;
    }
  }

  addNoise(map, { amp: 2.2, scale: 0.006, oct: 4, seed: 1.3 });
  addNoise(map, { amp: 0.8, scale: 0.02, oct: 3, seed: 7.7 });
  addNoise(map, { amp: 0.25, scale: 0.07, oct: 2, seed: 4.2 });

  // ---- features you can go looking for ----
  // A cliff band across the east face, with a rounded roll-in at either end.
  {
    const CZ = 300;
    for (let z = 0; z < h; z++) {
      const wz = z * sp; if (wz < CZ - 30) continue;
      for (let x = 0; x < w; x++) {
        const [wx] = gridToWorld(map, x, z);
        if (wx < 40 || wx > 330) continue;
        const drop = 7 * (1 - smooth01((Math.abs(wx - 185) - 80) / 55));
        if (drop < 0.05) continue;
        const cz = CZ + fbm(wx * 0.011 + 5.1, 2.2, 3) * 9;
        map.heights[z * w + x] -= drop * smooth01((wz - cz) / 5);
      }
    }
  }
  // A mogul field on the lower middle face.
  for (let row = 0; row * 10 < 150; row++) {
    const z = 560 + row * 10;
    for (let col = -8; col <= 8; col++) {
      const px = -40 + col * 7 + (row % 2 ? 3.5 : 0) + (rand() - 0.5) * 3;
      const pz = z + (rand() - 0.5) * 3;
      if (rand() < 0.2) continue;
      applyBrush(map, { tool: 'raise', x: px, z: pz, radius: 4.4 + rand() * 1.8, strength: 1, dt: 0.07 + rand() * 0.04, falloff: 0.05 });
    }
  }
  // Rollers down the west face, and a few natural hits scattered where they fall.
  addRollers(map, { z0: 180, z1: 420, wavelength: 52, amp: 1.6 });
  for (const [kx, kz, r, kh] of [[-90, 250, 15, 3.4], [95, 430, 13, 2.8], [-200, 560, 12, 2.4], [30, 690, 16, 3.6], [-320, 380, 11, 2.2]]) {
    kicker(map, kx, kz, { radius: r, height: kh });
  }
  smoothAll(map, 1, (x, z) => (z > 880 ? 1 : 0));          // the base area is groomed flat

  // ---- lifts ----
  // The summit chair runs the full height of the hill up the east side of the middle face, so it
  // is never over the best line. The bowl chair is a shorter one back up the west side.
  map.lifts = [
    { id: 'summit', name: 'Summit Express', base: { x: 70, z: 930 }, top: { x: 40, z: 60 } },
    { id: 'bowl', name: 'Bowl Chair', base: { x: -300, z: 800 }, top: { x: -170, z: 210 } },
  ];

  // ---- dressing ----
  forest(map, rand, { x0: -470, x1: -300, z0: 200, z1: 820, density: 0.0022, minGap: 11, types: ['fir', 'pine', 'birch'],
    keepOut: (x, z) => Math.abs(x - (-300 + (z - 800) * 0.22)) < 26 });
  forest(map, rand, { x0: -240, x1: -60, z0: 420, z1: 860, density: 0.0018, minGap: 12, types: ['pine', 'fir'] });
  forest(map, rand, { x0: 200, x1: 480, z0: 340, z1: 880, density: 0.0024, minGap: 11, types: ['fir', 'pine'] });
  forest(map, rand, { x0: -500, x1: 500, z0: 880, z1: 1010, density: 0.0012, minGap: 16, types: ['pine', 'birch'],
    keepOut: (x, z) => Math.abs(x) < 120 });
  // rocks along the spurs and under the cliff
  for (let z = 120; z < 700; z += 22) {
    for (const at of [-150, 160]) {
      const jitter = (rand() - 0.5) * 30;
      place(map, rand() < 0.5 ? 'rock' : 'boulder', at + jitter, z + rand() * 12, { s: 1 + rand() * 0.9, r: rand() * 3 });
    }
  }
  for (let i = 0; i < 26; i++) place(map, 'rock', 60 + rand() * 260, 312 + rand() * 40, { s: 1.2 + rand() * 0.8, r: rand() * 3 });
  for (let i = 0; i < 18; i++) place(map, 'boulder', -430 + rand() * 120, 260 + rand() * 480, { s: 1 + rand() * 0.8, r: rand() * 3 });

  // the base area
  place(map, 'hut', -60, 962, { r: 0.4, s: 1.4 });
  place(map, 'hut', -96, 976, { r: 0.9 });
  place(map, 'sign', 40, 918, { r: Math.PI });
  place(map, 'sign', -290, 792, { r: Math.PI });
  for (let i = 0; i < 10; i++) place(map, 'flag', -110 + i * 22, 940 + (i % 2) * 8);
  for (let i = 0; i < 6; i++) place(map, 'lamp', -120 + i * 44, 968);
  place(map, 'snowman', 6, 952); place(map, 'snowman', 13, 958, { s: 0.8 });
  // markers at the top of each face so you can tell them apart from the summit
  for (const [sx, sz] of [[-250, 120], [0, 110], [200, 120]]) { place(map, 'flag', sx, sz); place(map, 'flag', sx + 10, sz + 6); }

  // You start at the summit, so the first thing you do is ride. The lift is waiting when you
  // reach the bottom, which is a better introduction to it than starting in a queue.
  map.start = { x: 20, z: 96, yaw: 0 };
  finish(map, SPAN - 12, 40);
  pruneSteepProps(map);
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
