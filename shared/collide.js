// What a collider IS, and what hitting one does to you.
//
// This lives on its own because it used to live in two places -- the game loop and the headless
// sim -- and both of them were wrong in the same way for the same reason: a collider was a circle
// in x/z with no height at all, which makes it an infinitely tall cylinder. Clearing a one-metre
// boulder by six metres of air counted as hitting it, and so did flying over a tree.
import { PROP_TYPES, heightAt } from './mapformat.js';

// Build the collider list for a map. `hardOnly` is what the sim wants; the game also wants the
// soft ones so it can stumble you on a slalom pole.
export function buildColliders(map, { hardOnly = false, pad = 0 } = {}) {
  const out = [];
  for (const p of map.props || []) {
    const def = PROP_TYPES[p.t];
    if (!def) continue;
    if (hardOnly && !(def.r > 0 && def.hard)) continue;
    const sc = p.s || 1;
    const base = heightAt(map, p.x, p.z);
    const top = base + (def.ch || 2) * sc;
    if (p.t === 'gate') {
      const c = Math.cos(p.r || 0), s = Math.sin(p.r || 0), hw = def.width / 2;
      for (const side of [-1, 1]) {
        out.push({ x: p.x + side * hw * c, z: p.z - side * hw * s, r: 0.12 + pad, hard: false, t: 'pole', base, top, taper: 0 });
      }
      continue;
    }
    if (p.t === 'fence') {
      const c = Math.cos(p.r || 0), s = Math.sin(p.r || 0), hl = def.len / 2;
      for (let k = -1; k <= 1; k += 0.25) {
        out.push({ x: p.x + k * hl * c, z: p.z - k * hl * s, r: 0.7 + pad, hard: true, t: 'fence', base, top, taper: 0 });
      }
      continue;
    }
    if (def.r > 0) out.push({ x: p.x, z: p.z, r: def.r * sc + pad, hard: def.hard, t: p.t, base, top, taper: def.taper || 0 });
  }
  return out;
}

// The collider's radius at the height you are actually at. A conifer is a spike, not a pillar:
// full width at the trunk, a quarter of it at the tip, so clipping the top of a tree costs you
// a glance rather than a full stop.
export function radiusAt(o, y) {
  if (!o.taper) return o.r;
  const f = Math.max(0, Math.min(1, (y - o.base) / Math.max(0.5, o.top - o.base)));
  return o.r * (1 - f * (1 - o.taper));
}

// Over it is past it.
export function clears(o, y) { return y > o.top; }

// Are you inside this one, at this height? Returns the overlap depth, or 0 for a miss.
export function overlap(o, x, y, z) {
  if (clears(o, y)) return 0;
  const rad = radiusAt(o, y);
  const d = Math.hypot(o.x - x, o.z - z);
  return d < rad ? { d, rad } : 0;
}

// EASY MODE: a bonk, not a crash.
//
// The push is taken ACROSS your direction of travel rather than straight back along the contact
// normal, because a normal push at a tree you hit square on sends you back up the hill, which is
// both wrong and infuriating. This steers you round it and costs you a little speed.
// `nx, nz` is the unit normal from the object to you. Returns the new velocity components.
export function bonk(vx, vz, nx, nz, { keep = 0.93, base = 2.2, perSpeed = 0.22, max = 6.5 } = {}) {
  const sp = Math.hypot(vx, vz) || 1;
  const ux = vx / sp, uz = vz / sp;
  const dot = nx * ux + nz * uz;
  let sx = nx - ux * dot, sz = nz - uz * dot;      // the part of the normal that is sideways
  const sl = Math.hypot(sx, sz);
  // Dead head-on has no sideways component at all. Pick a side rather than stall on the spot.
  if (sl < 1e-3) { sx = -uz; sz = ux; } else { sx /= sl; sz /= sl; }
  const push = Math.min(max, base + sp * perSpeed);
  return { vx: (vx + sx * push) * keep, vz: (vz + sz * push) * keep, push };
}

// Which modelled variant a prop uses. Shared with the renderer rather than reimplemented there,
// because a rail whose SURFACE came from one variant and whose MESH came from another is the exact
// class of bug that took two rounds to find in the collider code.
export function variantIndex(p, n) {
  if (!n || n < 2) return 0;
  // An explicit choice wins. Without one, the position decides -- which is what you want for a
  // forest nobody placed by hand, and not what you want for the four rails you put down on purpose.
  if (Number.isInteger(p.v) && p.v >= 0) return p.v % n;
  return Math.abs(Math.round(p.x * 7.31 + p.z * 13.17)) % n;
}

// Sizes of the modelled rails, [width, height, length] per variant, newest measurement wins.
// The browser fills this from the geometry it loaded; Node reads assets/sizes.json.
let RAIL_SIZES = null;
export function setRailSizes(list) { RAIL_SIZES = list && list.length ? list : null; }
export function railSizes() { return RAIL_SIZES; }

// Rails are SURFACE rather than obstacle -- you ride on top of a box, you do not bump into it --
// so this returns a ground height, and the rest of the game treats it as ground.
export function buildRails(map) {
  const fallback = [[PROP_TYPES.rail.railW, PROP_TYPES.rail.railH, PROP_TYPES.rail.len]];
  const sizes = RAIL_SIZES || fallback;
  return (map.props || []).filter((p) => p.t === 'rail').map((p) => {
    const sc = p.s || 1, r = p.r || 0;
    // Each rail is whatever the model it was given actually measures. Nothing is stretched to a
    // common box, so the box has to follow the model instead.
    const [W, H, L] = sizes[variantIndex(p, sizes.length)];
    return {
      x: p.x, z: p.z, ax: Math.sin(r), az: Math.cos(r), px: Math.cos(r), pz: -Math.sin(r),
      halfL: (L * sc) / 2, halfW: (W * sc) / 2, h: H * sc,
      ramp: Math.min(1.4 * sc, L * sc * 0.28),
      top: heightAt(map, p.x, p.z) + H * sc,
    };
  });
}

const sm = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// The rail surface, and it has to be CONTINUOUS.
//
// A hard cutoff at the rail's edge is a 1.5 m cliff in the ground function, and the board's contact
// is a soft minimum over nine samples spread wider than the rail: as it moves, samples cross that
// cliff one at a time and the contact height jumps with each one. That is the jitter. The edges now
// fall to the surrounding snow over the outer quarter of the width, so the surface is continuous
// everywhere and the samples have something smooth to average.
//
// And that is ALL a rail is: a raised piece of ground. No altitude test, no special case for
// passing beneath one. Two bugs came out of trying to be cleverer than that, in opposite
// directions -- first standing you on a box you were passing under, then letting you ride through
// every rail on the map.
// Which rail is the surface here, if any. The normal needs to know WHICH bar it is standing on,
// because a bar is level across its own width and that width has a direction.
export function railUnder(rails, wx, wz, groundAt) {
  let best = -Infinity, hit = null;
  for (const r of rails) {
    const y = railOne(r, wx, wz, groundAt);
    if (y > best) { best = y; hit = r; }
  }
  return hit;
}

export function railHeightAt(rails, wx, wz, groundAt) {
  let best = -Infinity;
  for (const r of rails) {
    const y = railOne(r, wx, wz, groundAt);
    if (y > best) best = y;
  }
  return best;
}

function railOne(r, wx, wz, groundAt) {
  const dx = wx - r.x, dz = wz - r.z;
  const t = dx * r.ax + dz * r.az;
  if (t < -r.halfL || t > r.halfL) return -Infinity;
  const u = dx * r.px + dz * r.pz;
  if (u < -r.halfW || u > r.halfW) return -Infinity;
  const ends = Math.min(1, (r.halfL - Math.abs(t)) / r.ramp);   // ramped at both ends
  // Only a 12% roll-off each side. A tall narrow rail has vertical sides whatever you do -- you
  // cannot taper 1.5 m of drop across 5 cm and call it gentle -- so the taper is not there to
  // soften the sides, it is there to make the function continuous. What actually decides whether
  // the board sits still is how much FLAT TOP is left for its contact samples, and every
  // centimetre spent tapering is a centimetre taken off that.
  const edge = sm((r.halfW - Math.abs(u)) / (r.halfW * 0.12));
  // The surface rides the GROUND, not a fixed altitude. A rail used to be a horizontal plank at
  // anchorGround + height, which is only right where the snow is level: on a slope the deck buries
  // itself uphill and floats metres in the air downhill, and its footprint edge becomes a cliff in
  // the height function. Cross underneath one of those and the contact reports a metre of
  // penetration, so the rider is ejected to the top of it -- fall through, pop up, fall through.
  // Following the ground instead makes the rail a ribbon a fixed height above the snow: continuous
  // with the terrain everywhere, and there is no "underneath" left to be caught in.
  //
  // It follows the ground along its LENGTH only. The height is taken on the bar's centreline, so
  // the deck stays level ACROSS its width the way a rigid bar is -- sampling under each point
  // instead tilts the top with the hill and costs most of the flat that the board needs.
  const cx = r.x + r.ax * t, cz = r.z + r.az * t;
  const base = groundAt ? groundAt(cx, cz) : r.top - r.h;
  const k = ends * edge;                    // 0 at the edge of the footprint, 1 along the middle
  return base + r.h * k;
}

// What the surface is made of here: 0 snow, 1 steel. Not derived from the height, because the
// height climbs 1.25 m across a 2 cm taper -- anything based on it is a step, and the contact point
// dithering either side of that step would chatter the grip between snow and steel. This ramps
// across the last few centimetres of the deck instead, so crossing onto a rail changes what you
// are riding on over about a board's-edge of travel rather than instantly.
const SLIP_RAMP = 0.06;      // m
export function railSlipAt(rails, wx, wz) {
  let best = 0;
  for (const r of rails) {
    const dx = wx - r.x, dz = wz - r.z;
    const t = dx * r.ax + dz * r.az;
    if (t < -r.halfL || t > r.halfL) continue;
    const u = dx * r.px + dz * r.pz;
    if (u < -r.halfW || u > r.halfW) continue;
    const inset = Math.min(r.halfW - Math.abs(u), r.halfL - Math.abs(t));
    const k = sm(inset / SLIP_RAMP);
    if (k > best) best = k;
  }
  return best;
}

// How far above the surrounding snow the rail surface is here, 0 to 1 over the first 25 cm. The
// normal blends on this rather than switching: a box top is flat, but flipping the normal the
// instant a sample crosses onto the rail makes the board snap between two orientations.
export function railLift(rails, wx, wz, groundY, groundAt) {
  const y = railHeightAt(rails, wx, wz, groundAt);
  if (!(y > groundY)) return 0;
  return Math.min(1, (y - groundY) / 0.25);
}
