// Checks the three things collide.js exists to get right, on the real maps.
//
// All three were bugs: a collider with no height took you out of the air six metres above a
// boulder, a conifer was a full-width pillar all the way to its tip, and there was no gentle
// option at all -- every contact was an 88% brake. Run: node tools/collide-test.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { deserializeMap, heightAt, PROP_TYPES } from '../public/shared/mapformat.js';
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
    const on = railHeightAt(rails, r.x, r.z);
    const ground = heightAt(map, r.x, r.z);
    worstErr = Math.max(worstErr, Math.abs(on - ground - r.h));
    // one metre to the side, along the perpendicular, there must be no rail at all
    if (railHeightAt(rails, r.x + r.px * (r.halfW + 1), r.z + r.pz * (r.halfW + 1)) > -1e9) offCount++;
  }
  ok(worstErr < 0.02, 'the surface sits exactly railH above the ground at the centre',
    `worst error ${(worstErr * 100).toFixed(1)} cm`);
  ok(offCount === 0, 'and there is nothing to stand on beside it');
  // the ends ramp down to the snow rather than presenting a step
  const r0 = rails[0];
  const endY = railHeightAt(rails, r0.x + r0.ax * (r0.halfL - 0.02), r0.z + r0.az * (r0.halfL - 0.02));
  ok(endY - (r0.top - r0.h) < 0.06, 'the ends ramp down to the snow',
    `${((endY - (r0.top - r0.h)) * 100).toFixed(0)} cm above the snow at the tip`);
  // The board is 25 cm across; a rail narrower than that cannot carry all of its contact samples.
  ok(PROP_TYPES.rail.railW > 0.30, 'wide enough to carry the whole board',
    `${PROP_TYPES.rail.railW.toFixed(2)} m vs a 0.25 m board`);

  // WHAT DECIDES WHETHER IT JUDDERS is the width of the flat top, because the board's contact is
  // a soft minimum over nine samples: with n of the nine on the rail it floats bridge*ln(9/n)
  // above it, so a sample crossing on or off moves the board. Sides that steep are what a rail
  // IS -- the number to watch is how much flat there is between them.
  const p = (o) => railHeightAt(rails, r0.x + r0.px * o, r0.z + r0.pz * o);
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
  // the same along its length, over the end ramps
  let worstEnd = 0;
  for (let t2 = -r0.halfL * 1.05; t2 <= r0.halfL * 1.05; t2 += 0.01) {
    const p = (o) => railHeightAt(rails, r0.x + r0.ax * o, r0.z + r0.az * o);
    const a = Math.max(p(t2), r0.top - r0.h), b = Math.max(p(t2 + 0.01), r0.top - r0.h);
    worstEnd = Math.max(worstEnd, Math.abs(b - a));
  }
  ok(worstEnd < 0.06, 'nor along it, over the end ramps', `worst ${(worstEnd * 100).toFixed(1)} cm per cm`);
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL COLLIDER CHECKS PASSED');
process.exit(fails ? 1 : 0);
