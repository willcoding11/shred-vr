// Is the take-off edge a straight, level line?  Run: node tools/kicker-test.mjs
//
// It was not. The deck profile across the ramp was `1 - |v|^4`, commented as "flat deck, rounded
// shoulders", and it is a dome: the lip stood higher in the middle than at its edges and the
// surface leaned sideways everywhere off the centreline. Crossing it anywhere but dead centre
// pushed you off your line -- worse at low speed, because you spend longer on it.
//
// What matters is not the shape in the abstract but over how much of the lip the LAUNCH DIRECTION
// is the same, so that is what this measures: the width where the surface leans less than two
// degrees sideways. Everything outside that is the shoulder, which is supposed to fall away.
import { createMap, applyBrush, heightAt } from '../public/shared/mapformat.js';

const R = 9, HEIGHT = 3;
let fails = 0;
const ok = (c, label, detail = '') => { if (!c) fails++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`); };
const smooth01 = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// The two cross-deck profiles, as pure functions, so old and new can be compared exactly rather
// than through a discrete heightfield that blurs the very thing being measured.
const OLD = { halfW: R * 0.62, across: (a) => (a >= 1 ? 0 : 1 - Math.pow(a, 4)) };
const NEW = { halfW: R * 0.72, across: (a) => (a >= 1 ? 0 : a <= 0.62 ? 1 : 1 - smooth01((a - 0.62) / 0.38)) };

// How far either side of centre the lip leans less than `limit` degrees, and how much it drops.
function usable(p, limit = 2) {
  const h = (x) => HEIGHT * p.across(Math.abs(x) / p.halfW);
  const d = 0.02;
  let x = 0;
  for (; x < p.halfW; x += d) {
    const tilt = Math.abs(Math.atan2(h(x + d) - h(x - d), 2 * d)) * 57.3;
    if (tilt > limit) break;
  }
  return { half: x, width: x * 2, drop: h(0) - h(x) };
}

console.log('THE LIP: how much of it launches you the same way');
{
  const o = usable(OLD), n = usable(NEW);
  console.log(`  before   ${o.width.toFixed(1)} m of ${(OLD.halfW * 2).toFixed(1)} m deck, dropping ${(o.drop * 100).toFixed(0)} cm across it`);
  console.log(`  after    ${n.width.toFixed(1)} m of ${(NEW.halfW * 2).toFixed(1)} m deck, dropping ${(n.drop * 100).toFixed(0)} cm across it`);
  ok(n.width >= 6, 'the straight part of the lip is at least 6 m wide', `${n.width.toFixed(1)} m`);
  ok(n.drop < 0.05, 'and level across all of it', `drops ${(n.drop * 100).toFixed(1)} cm`);
  ok(n.width > o.width * 2, 'which is a real improvement on what it was', `${o.width.toFixed(1)} m -> ${n.width.toFixed(1)} m`);
}

console.log('');
console.log('THE LEAN, across the deck');
console.log('  offset    before    after');
{
  for (let f = 0; f <= 1.001; f += 0.2) {
    const tilt = (p) => {
      const h = (x) => HEIGHT * p.across(Math.abs(x) / p.halfW);
      const x = f * p.halfW, d = 0.02;
      return Math.abs(Math.atan2(h(x + d) - h(x - d), 2 * d)) * 57.3;
    };
    console.log(`  ${(f * 100).toFixed(0).padStart(5)}%  ${tilt(OLD).toFixed(1).padStart(7)} deg ${tilt(NEW).toFixed(1).padStart(7)} deg`);
  }
}

console.log('');
console.log('THE DECK, along the ramp (built for real, on flat ground)');
{
  const map = createMap({ id: 't', name: 'T', w: 90, h: 90, spacing: 1, slopeDeg: 0, h0: 0 });
  applyBrush(map, { tool: 'kicker', x: 0, z: 40, radius: R, height: HEIGHT, yaw: 0 });
  const LIP_Z = 40 + 0.85 * R;
  const top = heightAt(map, 0, LIP_Z);
  ok(top > HEIGHT * 0.9, 'the lip reaches its full height', `${top.toFixed(2)} m of ${HEIGHT}`);
  const before = heightAt(map, 0, LIP_Z - 1.5);
  ok(before < top && before > HEIGHT * 0.6, 'the run-up is a ramp, not a step', `${before.toFixed(2)} m 1.5 m back`);
  const behind = heightAt(map, 0, 40 + 1.25 * R);
  ok(behind < HEIGHT * 0.35, 'the back is a knuckle, not a wall', `${behind.toFixed(2)} m`);
  // And the built lip really is level where the profile says it should be -- stopping a grid cell
  // short of the shoulder, because bilinear sampling blends the first cell of the falling edge
  // back inside the flat zone. That blur is the heightfield's resolution, not the ramp's shape,
  // and it is wider on a real map at 3 m spacing than on this 1 m test grid.
  const flat = NEW.halfW * 0.62 - map.spacing;
  let drop = 0;
  for (let x = -flat; x <= flat; x += 0.25) {
    drop = Math.max(drop, heightAt(map, 0, LIP_Z) - heightAt(map, x, LIP_Z));
  }
  ok(drop < 0.05, 'the built ramp agrees with the profile', `level across ${(flat * 2).toFixed(1)} m, drops ${(drop * 100).toFixed(1)} cm`);
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL KICKER CHECKS PASSED');
process.exit(fails ? 1 : 0);
