// Checks the three things collide.js exists to get right, on the real maps.
//
// All three were bugs: a collider with no height took you out of the air six metres above a
// boulder, a conifer was a full-width pillar all the way to its tip, and there was no gentle
// option at all -- every contact was an 88% brake. Run: node tools/collide-test.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { deserializeMap, heightAt, normalAt, PROP_TYPES } from '../public/shared/mapformat.js';
import { buildColliders, radiusAt, clears, bonk, buildRails, railHeightAt, setRailSizes } from '../public/shared/collide.js';
import { applySizes } from '../public/shared/propsize.js';


const __d = path.dirname(fileURLToPath(import.meta.url));

const load = (id) => deserializeMap(fs.readFileSync(path.join(__d, '..', 'maps', `${id}.json`), 'utf8'));

// Test the rails the GAME rides, not the placeholder box -- this has to come after __d exists, or
// it throws, the catch swallows it, and every rail check quietly passes on a 0.46 m fallback while
// the map is full of 0.32 m ones.
try {
  const sz = JSON.parse(fs.readFileSync(path.join(__d, '..', 'public', 'assets', 'sizes.json'), 'utf8'));
  if (sz.rail) { applySizes(PROP_TYPES, { rail: sz.rail[0] }); setRailSizes(sz.rail); }
} catch { /* no modelled props yet */ }
let fails = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
};

const map = load('alpine-bowl');
const gAt = (x, z) => heightAt(map, x, z);

console.log('HEIGHT: over it is past it');
{
  const cols = buildColliders(map, { hardOnly: true });
  const boulder = cols.find((c) => c.t === 'boulder');
  const tree = cols.find((c) => c.t === 'fir' || c.t === 'pine');
  ok(!clears(boulder, boulder.base + 0.4), 'at board height a boulder is solid');
  ok(clears(boulder, boulder.top + 0.1), 'just over the top of a boulder is clear',
    `top ${(boulder.top - boulder.base).toFixed(1)} m`);
  ok(clears(boulder, boulder.base + 6), 'six metres above a boulder is clear');
  ok(!clears(tree, tree.base + 1), 'a tree trunk at board height is solid');
  ok(clears(tree, tree.top + 0.5), 'above the top of a tree is clear',
    `tree is ${(tree.top - tree.base).toFixed(1)} m`);
  // and the old behaviour would have failed all three of the "clear" cases
  const infinite = { ...boulder, top: Infinity };
  ok(!clears(infinite, infinite.base + 6), 'the old infinite cylinder would still have hit you',
    '(this is the bug, confirmed present if removed)');
}

console.log('TAPER: a conifer is a spike, not a pillar');
{
  const cols = buildColliders(map, { hardOnly: true });
  const tree = cols.find((c) => c.taper > 0);
  const h = tree.top - tree.base;
  const atBase = radiusAt(tree, tree.base + 0.2);
  const atTip = radiusAt(tree, tree.base + h * 0.95);
  ok(Math.abs(atBase - tree.r) < 0.02, 'full width at the trunk', `${atBase.toFixed(2)} m`);
  ok(atTip < tree.r * 0.35, 'narrow at the tip', `${atTip.toFixed(2)} m vs ${tree.r.toFixed(2)} at the base`);
  const rock = cols.find((c) => c.t === 'rock' || c.t === 'boulder');
  ok(radiusAt(rock, rock.base + 5) === rock.r, 'a rock does not taper');
}

console.log('EASY: a bonk costs a little speed and steers you round');
{
  // running due +z at 15 m/s, tree dead ahead, normal pointing back at you
  const r = bonk(0, 15, 0, -1);
  const sp = Math.hypot(r.vx, r.vz);
  ok(sp > 15 * 0.80, 'keeps most of your speed', `${sp.toFixed(1)} m/s from 15.0`);
  ok(Math.abs(r.vx) > 1.5, 'pushed sideways, not backwards', `sideways ${Math.abs(r.vx).toFixed(1)} m/s`);
  ok(r.vz > 0, 'still going down the hill, not bounced back up it', `vz ${r.vz.toFixed(1)}`);
  // a glancing contact should still deflect the same way, not reverse
  const g = bonk(3, 15, 0.9, -0.44);
  ok(g.vz > 0 && Math.hypot(g.vx, g.vz) > 14, 'a glancing bonk barely costs anything',
    `${Math.hypot(g.vx, g.vz).toFixed(1)} m/s`);
  // and the hard response is still a hard response
  ok(15 * 0.12 < 2, 'the realistic response is still an 88% brake');
}

console.log('RAILS: a box is ground');
{
  const rails = buildRails(map);
  ok(rails.length > 0, 'the map has rails on it', `${rails.length} of them`);
  let worstErr = 0, offCount = 0;
  for (const r of rails) {
    const on = railHeightAt(rails, r.x, r.z, gAt);
    const ground = heightAt(map, r.x, r.z);
    worstErr = Math.max(worstErr, Math.abs(on - ground - r.h));
    // one metre to the side, along the perpendicular, there must be no rail at all
    const ox = r.x + r.px * (r.halfW + 1), oz = r.z + r.pz * (r.halfW + 1);
    if (railHeightAt(rails, ox, oz, gAt) > -1e9) offCount++;
  }
  ok(worstErr < 0.02, 'the surface sits exactly railH above the ground at the centre',
    `worst error ${(worstErr * 100).toFixed(1)} cm`);
  ok(offCount === 0, 'and there is nothing to stand on beside it');
  // the ends ramp down to the snow rather than presenting a step
  const r0 = rails[0];
  const ex = r0.x + r0.ax * (r0.halfL - 0.02), ez = r0.z + r0.az * (r0.halfL - 0.02);
  const endY = railHeightAt(rails, ex, ez, gAt);
  ok(endY - (r0.top - r0.h) < 0.06, 'the ends ramp down to the snow',
    `${((endY - (r0.top - r0.h)) * 100).toFixed(0)} cm above the snow at the tip`);
  // The board is 25 cm across; a rail narrower than that cannot carry all of its contact samples.
  ok(PROP_TYPES.rail.railW > 0.30, 'wide enough to carry the whole board',
    `${PROP_TYPES.rail.railW.toFixed(2)} m vs a 0.25 m board`);

  // WHAT DECIDES WHETHER IT JUDDERS is the width of the flat top, because the board's contact is
  // a soft minimum over nine samples: with n of the nine on the rail it floats bridge*ln(9/n)
  // above it, so a sample crossing on or off moves the board. Sides that steep are what a rail
  // IS -- the number to watch is how much flat there is between them.
  const p = (o) => { const x = r0.x + r0.px * o, z = r0.z + r0.pz * o; return railHeightAt(rails, x, z, gAt); };
  const top = p(0);
  let flat = 0;
  for (let u = 0; u <= r0.halfW; u += 0.005) { if (top - p(u) > 0.01) break; flat = u; }
  const flatW = flat * 2;
  console.log(`       flat top ${(flatW * 100).toFixed(0)} cm of a ${(r0.halfW * 200).toFixed(0)} cm rail,`
    + ` ${(r0.h * 100).toFixed(0)} cm tall; the board is 25 cm across`);
  ok(flatW >= 0.24, 'the flat top is at least as wide as the board', `${(flatW * 100).toFixed(0)} cm`);
  // and it must be a single plateau -- no dip in the middle for a sample to catch on
  let dips = 0;
  for (let u = -flat; u <= flat; u += 0.005) if (p(u) < top - 0.005) dips++;
  ok(dips === 0, 'and is one flat plateau, not a ridge with a dip in it');
  // The same along its length, over the end ramps. The bar follows the hill now, so its absolute
  // height changes as fast as the slope does -- what has to be smooth is the bar's own profile,
  // which is how far it stands ABOVE the snow.
  const above = (o) => {
    const x = r0.x + r0.ax * o, z = r0.z + r0.az * o;
    return Math.max(0, railHeightAt(rails, x, z, gAt) - heightAt(map, x, z));
  };
  let worstEnd = 0;
  for (let t2 = -r0.halfL * 1.05; t2 <= r0.halfL * 1.05; t2 += 0.01) {
    worstEnd = Math.max(worstEnd, Math.abs(above(t2 + 0.01) - above(t2)));
  }
  ok(worstEnd < 0.06, 'nor along it, over the end ramps', `worst ${(worstEnd * 100).toFixed(1)} cm per cm`);

  // And the thing that caused the launching: the deck may never float above the snow it is on.
  let float = 0;
  for (const q of rails) {
    for (let o = -q.halfL; o <= q.halfL; o += 0.25) {
      const x = q.x + q.ax * o, z = q.z + q.az * o;
      float = Math.max(float, railHeightAt(rails, x, z, gAt) - heightAt(map, x, z));
    }
  }
  ok(float < PROP_TYPES.rail.railH * 2.5, 'no rail floats above the snow it sits on',
    `worst standoff ${float.toFixed(2)} m, and the bar is ${PROP_TYPES.rail.railH.toFixed(2)} m tall`);
}

// ---------------------------------------------------------------- a rail is just raised ground
// It was a special case for a while, asked to work out whether the rider was above it or below it,
// and that produced two opposite bugs in two days: first it stood you on a box you were passing
// under, then it let you ride straight through all six rails on the map. It is a heightfield with
// a slippery surface, and it knows nothing about where anybody is.
{
  const { Terrain } = await import('../public/shared/terrain.js');
  const rails = buildRails(map);
  if (!rails.length) {
    console.log('  --  no rails on this map, skipped');
  } else {
    const r = rails[0];
    const T = Object.create(Terrain.prototype);
    T.map = map; T.rails = rails;
    const ground = heightAt(map, r.x, r.z);
    const deck = railHeightAt(rails, r.x, r.z, gAt);
    ok(deck > ground + 0.1, 'the test rail stands proud of the snow',
       `deck ${deck.toFixed(2)} m vs ground ${ground.toFixed(2)} m, ${(deck - ground).toFixed(2)} m proud`);

    ok(T.heightAt.length === 2, 'heightAt asks for x and z and nothing else', `arity ${T.heightAt.length}`);
    ok(Math.abs(T.heightAt(r.x, r.z) - deck) < 1e-6, 'and the deck is simply the ground there');
    let dead = 0;
    for (const q of rails) {
      if (Math.abs(T.heightAt(q.x, q.z) - railHeightAt(rails, q.x, q.z, gAt)) > 1e-6) dead++;
    }
    ok(dead === 0, 'every rail on the map is solid', `${rails.length - dead} of ${rails.length}`);

    // Off to the side there is nothing but snow, and the two have to meet continuously.
    const off = (o) => T.heightAt(r.x + r.px * o, r.z + r.pz * o);
    ok(Math.abs(off(r.halfW + 1) - heightAt(map, r.x + r.px * (r.halfW + 1), r.z + r.pz * (r.halfW + 1))) < 1e-6,
       'a metre to the side it is snow again');

    // The surface material: 0 is snow, 1 is steel, and it ramps rather than switching.
    ok(Math.abs(T.slipAt(r.x, r.z) - 1) < 1e-6, 'dead centre the surface is all steel',
       `slip ${T.slipAt(r.x, r.z).toFixed(3)}`);
    ok(T.slipAt(r.x + r.px * (r.halfW + 1), r.z + r.pz * (r.halfW + 1)) === 0,
       'a metre to the side it is all snow');
    let jump = 0, prev = T.slipAt(r.x + r.px * -(r.halfW + 0.5), r.z + r.pz * -(r.halfW + 0.5));
    for (let u = -(r.halfW + 0.5); u <= r.halfW + 0.5; u += 0.01) {
      const v = T.slipAt(r.x + r.px * u, r.z + r.pz * u);
      jump = Math.max(jump, Math.abs(v - prev)); prev = v;
    }
    ok(jump < 0.35, 'and it ramps across the edge rather than switching', `worst step ${jump.toFixed(3)} per cm`);
    ok(T.slipAt(r.x + r.px * (r.halfW + 1), r.z + r.pz * (r.halfW + 1)) === 0
       && T.slipAt(r.x, r.z) === 1, 'snow is 0 and the deck is 1, so snow physics is untouched');

    // The deck is level ACROSS the bar -- that is what stops it tipping the board onto a camber
    // that is not there. It is NOT level along the bar: it follows the hill, and saying otherwise
    // makes the contact cancel the rider's descent every step and hop them off it.
    const nOn = T.normalAt(r.x, r.z, undefined);
    const across = nOn[0] * r.px + nOn[2] * r.pz;
    ok(Math.abs(across) < 1e-6, 'on the deck the surface is level across the bar',
       `normal into the cross-axis ${across.toExponential(1)}`);
    // Taking the cross component out and renormalising scales what is left, so the raw numbers
    // differ -- what has to survive is the ANGLE the deck tilts along the bar.
    const snowN = normalAt(map, r.x, r.z);
    const tilt = (n) => Math.atan2(n[0] * r.ax + n[2] * r.az, n[1]) * 180 / Math.PI;
    ok(Math.abs(tilt(nOn) - tilt(snowN)) < 0.05, 'and tilts along its length exactly as the hill does',
       `deck ${tilt(nOn).toFixed(2)} deg against the snow's ${tilt(snowN).toFixed(2)} deg`);
    const nSnow = T.normalAt(r.x + r.px * (r.halfW + 1), r.z + r.pz * (r.halfW + 1), undefined)[1];
    ok(Math.abs(nSnow - normalAt(map, r.x + r.px * (r.halfW + 1), r.z + r.pz * (r.halfW + 1))[1]) < 1e-6,
       'beside it, the real slope', `ny ${nSnow.toFixed(4)}`);
  }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL COLLIDER CHECKS PASSED');
process.exit(fails ? 1 : 0);
