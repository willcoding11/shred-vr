// Starting shapes for a new map. Two kinds, because they are genuinely different things:
//
//   RUN      a corridor with walls either side, a start at one end and a finish at the other.
//   MOUNTAIN an open hill built in polar coordinates around one point at the bottom, so every
//            face on it drains to the same place and you can drop in anywhere.
//
// Neither is meant to be finished. They are a hill worth sculpting rather than a flat plane.
import { gridToWorld, fbm } from './mapformat.js';

const smooth01 = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const tand = (d) => Math.tan((d * Math.PI) / 180);

// Cell counts are what actually matter here: the terrain is one mesh with culling off, so a
// headset is drawing every triangle of it every frame. These are chosen to keep that in range,
// which is why the big ones use a coarser grid rather than simply more cells.
export const PRESET_SIZES = {
  run: {
    tiny:   { lengthM: 260,  widthM: 110, spacing: 2 },
    small:  { lengthM: 420,  widthM: 150, spacing: 2 },
    normal: { lengthM: 700,  widthM: 200, spacing: 2 },
    large:  { lengthM: 1040, widthM: 260, spacing: 2 },
    huge:   { lengthM: 1600, widthM: 320, spacing: 3 },
  },
  mountain: {
    tiny:   { lengthM: 300,  widthM: 300,  spacing: 2 },
    small:  { lengthM: 560,  widthM: 560,  spacing: 2 },
    normal: { lengthM: 1020, widthM: 1020, spacing: 3 },
    large:  { lengthM: 1500, widthM: 1500, spacing: 4 },
    huge:   { lengthM: 2100, widthM: 2100, spacing: 5 },
  },
};

// ---------------------------------------------------------------- a run
export function buildRun(map, { slopeDeg = 12, rough = 0.3, valley = 1, seed = Math.random() * 100 } = {}) {
  const { w, h } = map.size, sp = map.spacing;
  const halfW = ((w - 1) * sp) / 2, zEnd = (h - 1) * sp;
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const [wx, wz] = gridToWorld(map, x, z);
    let dy = 0;
    if (rough > 0) dy += fbm(wx * 0.02 + seed, wz * 0.02 + seed * 2, 3) * rough * 1.2 + fbm(wx * 0.08 + seed, wz * 0.08, 2) * rough * 0.3;
    if (valley > 0) { const u = Math.abs(wx) / halfW, t = Math.max(0, (u - 0.6) / 0.4); dy += Math.pow(t, 2.4) * 10 * valley; }
    if (wz < 24) dy += ((24 - wz) / 24) * tand(slopeDeg) * (24 - wz) * 0.5;
    if (wz > zEnd - 60) { const t = (wz - (zEnd - 60)) / 60; dy += t * t * 6; }
    map.heights[z * w + x] += dy;
  }
  map.freeride = false;
  map.lifts = [];
  map.start = { x: 0, z: 12, yaw: 0 };
  map.finish = { x: 0, z: zEnd - 50, w: 36 };
  return map;
}

// ---------------------------------------------------------------- a mountain
export function buildMountain(map, { relief = 1, rough = 1, seed = Math.random() * 100 } = {}) {
  const { w, h } = map.size, sp = map.spacing;
  const spanZ = (h - 1) * sp, spanX = (w - 1) * sp;
  const BX = 0, BZ = spanZ * 0.90;                 // the base area: everything drains here
  const reach = Math.hypot(spanX / 2, BZ);

  // Long profile as a function of distance from the base, normalised so it fits the map: steep
  // through the middle, easing at the bottom into an apron and at the top into a summit shoulder.
  const gradeAt = (u) => (                          // u = 0 at the base, 1 at the far rim
    u < 0.07 ? 3
      : u < 0.16 ? 3 + ((u - 0.07) / 0.09) * 20
        : u < 0.38 ? 25
          : u < 0.45 ? 13                           // a bench across the middle
            : u < 0.70 ? 28
              : u < 0.78 ? 18                       // a second bench
                : u < 0.93 ? 27
                  : 11) * relief;
  const NR = 260, STEP = reach / NR;
  const prof = new Float32Array(NR + 1);
  { let y = 0; for (let k = 0; k <= NR; k++) { prof[k] = y; y += tand(gradeAt(k / NR)) * STEP; } }
  const elev = (d) => {
    const t = Math.min(NR - 0.001, Math.max(0, d / STEP));
    const k = t | 0; return prof[k] + (prof[k + 1] - prof[k]) * (t - k);
  };

  // The valley axis leans across the hill as it climbs, so the fall line bends as you descend
  // instead of pointing at the base the whole way. A cone does not do this; a mountain does.
  const VALLEY = spanX * 0.16;
  const axisAt = (d) => BX + VALLEY * Math.sin(Math.min(1.6, Math.max(0, (d - reach * 0.22) / (reach * 0.45))));
  const polar = (wx, wz) => {
    const up = Math.max(BZ - wz, 0);
    const ax = axisAt(Math.hypot(wx - BX, up));
    return { d: Math.hypot(wx - ax, up), th: Math.atan2(wx - ax, Math.max(up, 1e-3)), behind: Math.max(0, wz - BZ) };
  };

  const SPURS = [-1.2, -0.42, 0.40, 1.15];
  const twist = (d) => ((d - reach * 0.5) / (reach * 0.5)) * 0.20;

  // Ways off the top. A rim that is a pure function of distance is a closed ring, and a closed ring
  // means the first thing a New Map hands you is a hill you cannot ride off: measured on the
  // generated mountain, every bearing crossed 55-63 degrees and the lift unloaded above it. At
  // these bearings the rim opens into a rollover instead. The lift top is put on the middle one.
  const RAMPS = [-0.78, 0.04, 0.60];
  const rimGate = (th) => {
    let open = 0;
    for (const r of RAMPS) { const u = (th - r) / 0.14; open = Math.max(open, Math.exp(-u * u)); }
    return 1 - open;
  };
  // One unambiguous high point, between two of the ramps, plus a ceiling so no corner of the map
  // can out-climb it -- the far shoulders otherwise rise above the summit and turn it into a col.
  const PEAK = { d: reach * 0.90, th: -0.37, h: reach * 0.075, rd: reach * 0.11, rth: 0.20 };
  const CAP = elev(reach * 0.95) + reach * 0.13, CAPSOFT = reach * 0.04;

  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const [wx, wz] = gridToWorld(map, x, z);
    const { d, th, behind } = polar(wx, wz);
    let y = elev(d);
    y += Math.pow(Math.abs(wx) / (spanX * 0.5), 2.1) * reach * 0.07;      // the hill dishes across
    const fade = smooth01((d - reach * 0.16) / (reach * 0.15)) * (1 - smooth01((d - reach * 0.93) / (reach * 0.13)));
    for (const base of SPURS) {                                           // ribs between the faces
      let a = th - (base + twist(d));
      while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2;
      const k = a / (0.20 + 0.00016 * d);
      y += Math.exp(-k * k) * (reach * 0.016 + d * 0.030) * fade;
    }
    // Relief that is not a function of (d, th), so one part of the hill is a different shape from
    // another part at the same height. Deliberately anisotropic -- short wavelength across the
    // hill, long down it -- so it makes ribs and hollows to ride between without steepening the
    // fall line enough to reverse the drainage and pond it.
    const rel = smooth01((d - reach * 0.16) / (reach * 0.17)) * (1 - smooth01((d - reach * 0.82) / (reach * 0.15)))
              * (1 - 0.45 * smooth01((Math.abs(th) - 0.55) / 0.60));
    if (rel > 0) {
      y += fbm(wx * 0.0052 + seed * 3, wz * 0.0019 + seed, 2) * reach * 0.022 * rel;
      y += fbm(wx * 0.0115 + seed, wz * 0.0042 + seed * 5, 2) * reach * 0.007 * rel;
    }
    const gate = rimGate(th);                                             // a rim you drop in over
    y += smooth01((d - reach * 0.82) / (reach * 0.09)) * reach * (0.017 + 0.040 * gate);
    if (behind > 0) {
      const b = smooth01(behind / 130);
      y += (Math.pow(Math.abs(wx) / (spanX * 0.34), 2) * 10 - behind * 0.075) * b;
    }
    // Far shoulders, scaled to the map. Hard-coding 74 m of rise and a 180 m fade made them
    // tower over a small hill and vanish on a big one.
    y += Math.pow(Math.max(0, Math.abs(wx) - spanX * 0.40) / (spanX * 0.17), 2) * reach * 0.055
       * smooth01((wz - spanZ * 0.18) / (spanZ * 0.18));
    const over = y - (CAP - CAPSOFT);
    if (over > 0) y = CAP - CAPSOFT + CAPSOFT * (1 - Math.exp(-over / CAPSOFT));
    { const u = (d - PEAK.d) / PEAK.rd, v = (th - PEAK.th) / PEAK.rth; y += Math.exp(-(u * u + v * v)) * PEAK.h; }
    if (rough > 0) {
      y += fbm(wx * 0.0045 + seed, wz * 0.0045 + seed * 2, 4) * 3.0 * rough;
      y += fbm(wx * 0.018 + seed, wz * 0.018, 3) * 1.0 * rough;
      y += fbm(wx * 0.07 + seed, wz * 0.07, 2) * 0.28 * rough;
    }
    map.heights[z * w + x] = y;
  }

  map.freeride = true;
  // One lift, base to rim, a little off the middle of the hill so it is not over the best line.
  const topD = reach * 0.86, topTh = RAMPS[1];
  map.lifts = [{
    id: 'summit', name: 'Summit Express',
    base: { x: BX + spanX * 0.05, z: BZ - 26 },
    top: { x: axisAt(topD) + Math.sin(topTh) * topD, z: BZ - Math.cos(topTh) * topD },
  }];
  map.start = { x: map.lifts[0].top.x + 14, z: map.lifts[0].top.z + 26, yaw: 0 };
  map.finish = { x: 0, z: spanZ - 12, w: 40 };
  return map;
}
