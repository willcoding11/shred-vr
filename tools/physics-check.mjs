// Checks the force model does what the control scheme promises. Every case here is something a
// player would physically do with their hands. Nothing calls a steering function, a jump
// function or a start function, because none of those exist -- there is only the contact patch.
//
// Assertions are written to FAIL on the bugs that have actually shipped in this model's history:
// a rider welded to the hill at ordinary board angles, carving that delivered no sustained force,
// a "body" that turned into a frictionless glide, and a jump that accumulated lift. A test that
// cannot fail is worse than no test, so anything tautological has been taken out.
// Run: node tools/physics-check.mjs
import * as THREE from '../node_modules/three/build/three.module.js';
import { Rider, SNOW, DEFAULT_TUNING } from '../public/game/physics.js';
import { makePose, deg, planarTerrain, flatOnSlope } from './pose.js';

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!cond) failures++;
};
const HEAD = new THREE.Vector3(0, 1.6, 0);

// An edge can only push toward its own side, so a carve is a tilt and a swing that AGREE. Which
// numeric sign of yaw agrees with which sign of edge is pure coordinate bookkeeping, and getting
// it backwards silently turns a carve test into a skid test that still looks entirely plausible.
// So it is written down once, here, and every carving test below goes through it.
const carve = (edgeDeg, rate, slope) => (t) =>
  makePose({ yaw: -Math.sign(edgeDeg || 1) * rate * t, edge: deg(edgeDeg), pitch: deg(slope) });
const against = (edgeDeg, rate, slope) => (t) =>
  makePose({ yaw: Math.sign(edgeDeg || 1) * rate * t, edge: deg(edgeDeg), pitch: deg(slope) });
const H = (n) => `\n${n}`;

// `push` is the velocity of your feet in rig space, or null for hands held still.
function run({ slope = 12, seconds = 3, pose, push = null, dt = 1 / 240, snow = 'groomed', head = HEAD }) {
  const r = new Rider(planarTerrain(slope));
  r.snow = SNOW[snow];
  const p0 = typeof pose === 'function' ? pose(0, r) : pose;
  r.reset(0, 0, 0, p0);
  let air = 0, peak = 0, maxG = 0, maxVy = 0;
  for (let i = 0; i < seconds / dt; i++) {
    const t = i * dt;
    const p = typeof pose === 'function' ? pose(t, r) : pose;
    const hv = typeof push === 'function' ? push(t, r) : push;
    r.step(dt, p, hv, 0, head);
    if (!r.grounded) air += dt;
    if (r.speed > peak) peak = r.speed;
    if (Math.abs(r.lateralG) > maxG) maxG = Math.abs(r.lateralG);
    if (r.vel.y > maxVy) maxVy = r.vel.y;
  }
  return { r, air, peak, maxG, maxVy };
}

// Bring a rider up to speed on a flat board, then do something and measure what happened.
function atSpeed(slope, seconds, poseFn, { dt = 1 / 240, warm = 5 } = {}) {
  const r = new Rider(planarTerrain(slope));
  r.snow = SNOW.groomed;
  const flat = flatOnSlope(slope, 0);
  r.reset(0, 0, 0, flat);
  for (let i = 0; i < warm / dt; i++) r.step(dt, flat, null, 0, HEAD);
  const h0 = Math.atan2(r.vel.x, r.vel.z), v0 = r.speed;
  let sumG = 0, n = 0, peakG = 0, sumR = 0;
  for (let i = 0; i < seconds / dt; i++) {
    r.step(dt, poseFn(i * dt), null, 0, HEAD);
    if (Math.abs(r.lateralG) > peakG) peakG = Math.abs(r.lateralG);
    if (i * dt > 0.5) { sumG += Math.abs(r.lateralG); sumR += Math.min(r.turnRadius, 400); n++; }
  }
  const swing = Math.abs(((Math.atan2(r.vel.x, r.vel.z) - h0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
  return { r, v0, swing, peakG, sustainG: sumG / n, radius: sumR / n, kept: r.speed / v0 };
}

// What a turn COSTS: metres per second of speed lost for each degree of direction change. This
// is the only fair way to compare techniques. Comparing raw speed kept is meaningless when one
// technique comes round 104 degrees and the other manages 17.
function turnCost(slope, seconds, poseFn, dt = 1 / 240) {
  const r = new Rider(planarTerrain(slope));
  r.snow = SNOW.groomed;
  const flat = flatOnSlope(slope, 0);
  r.reset(0, 0, 0, flat);
  for (let i = 0; i < 5 / dt; i++) r.step(dt, flat, null, 0, HEAD);
  const h0 = Math.atan2(r.vel.x, r.vel.z), v0 = r.speed;
  let sumG = 0, n = 0, peakG = 0;
  for (let i = 0; i < seconds / dt; i++) {
    r.step(dt, poseFn(i * dt), null, 0, HEAD);
    if (Math.abs(r.lateralG) > peakG) peakG = Math.abs(r.lateralG);
    if (i * dt > 0.5) { sumG += Math.abs(r.lateralG); n++; }
  }
  const swing = Math.abs(((Math.atan2(r.vel.x, r.vel.z) - h0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
  return { r, swing, peakG, sustainG: sumG / n, kept: r.speed / v0, perDeg: (v0 - r.speed) / Math.max(swing, 1) };
}

console.log(H('1. An edge set into the hill holds you. A flat base does not.'));
{
  const up = run({ slope: 14, seconds: 3, pose: makePose({ yaw: deg(90), edge: deg(-35), pitch: deg(2) }) }).r;
  check('parked across the hill on a set edge', up.speed < 1.0, `${up.speed.toFixed(2)} m/s after 3 s`);

  // "Flat" across a hill is NOT level with the horizon. A board held level while it lies across
  // a 14 deg slope is already 14 deg onto its uphill edge, which is precisely why you can stand
  // on a hill like that.
  const level = run({ slope: 14, seconds: 3, pose: makePose({ yaw: deg(90), edge: 0, pitch: 0 }) }).r;
  check('held level with the horizon, that is still an uphill edge', Math.abs(level.edgeDeg + 14) < 2,
    `reads ${level.edgeDeg.toFixed(1)} deg of edge`);
  const flat = run({ slope: 14, seconds: 3, pose: flatOnSlope(14, 90) }).r;
  check('flat on the snow sideslips instead', Math.abs(flat.edgeDeg) < 1 && flat.speed > up.speed + 0.4,
    `${flat.edgeDeg.toFixed(1)} deg of edge, ${flat.speed.toFixed(2)} m/s`);
}

console.log(H('2. Getting going, from any board angle, on any real slope.'));
{
  // The worst bug this model has had lived in this table. A flat board on a 16 deg slope pointed
  // 30 deg off the fall line settled at 0.00 m/s and stayed there for ever: plough drag scaled
  // with load rather than speed, so it was a brake that still worked at a standstill. The first
  // fix moved the dead zone instead of removing it, out past 60 deg where the original sweep did
  // not look -- and left the band INVERTED, with 90 deg of heading running faster than 60. So
  // this now goes all the way to sideways, and checks the shape as well as the numbers.
  const slopes = [4, 6, 8, 12, 16, 22];
  const yaws = [0, 30, 45, 60, 70, 80, 90];
  const grid = {}, rows = [];
  for (const slope of slopes) {
    const row = { slope };
    for (const yaw of yaws) {
      const v = run({ slope, seconds: 20, pose: flatOnSlope(slope, yaw) }).r.speed;
      grid[`${slope}:${yaw}`] = v;
      row[`${yaw}d`] = +(v * 3.6).toFixed(1);
    }
    rows.push(row);
  }
  console.log('  flat board, from rest, 20 s, km/h:');
  console.table(rows);

  // Pointing further across the hill may only ever cost you speed. Anything else means drag is
  // being charged along the board instead of against your travel, and a board sliding dead
  // sideways is being charged almost nothing.
  let inversion = null;
  for (const slope of slopes) {
    for (let i = 1; i < yaws.length; i++) {
      const prev = grid[`${slope}:${yaws[i - 1]}`], here = grid[`${slope}:${yaws[i]}`];
      if (here > prev + 0.25) inversion = `${slope} deg: ${yaws[i]} deg of heading runs faster than ${yaws[i - 1]}`;
    }
  }
  check('turning further across the hill never makes you faster', inversion === null,
    inversion || 'monotonic on every slope');

  // And a board pointed anywhere near down the hill always gets going, on any pitch worth riding.
  let worst = { v: Infinity };
  for (const slope of [6, 8, 12, 16, 22]) {
    for (const yaw of [0, 30, 45, 60]) {
      if (grid[`${slope}:${yaw}`] < worst.v) worst = { v: grid[`${slope}:${yaw}`], slope, yaw };
    }
  }
  check('within 60 deg of the fall line you always get moving', worst.v > 1.2,
    `worst is a ${worst.slope} deg slope at ${worst.yaw} deg: ${worst.v.toFixed(2)} m/s`);

  // A flat base sliding dead sideways has a sane terminal speed. It reached 70 km/h once, when
  // drag was being charged along the board instead of against travel. It should not be slow: a
  // genuinely flat base on a steep pitch does run, which is why you set an edge to scrub. But it
  // must not accelerate away either, or sideslipping stops being a way to control speed at all.
  const side = run({ slope: 20, seconds: 40, pose: flatOnSlope(20, 90) }).r.speed * 3.6;
  check('a flat base sideslipping drifts rather than running away', side > 8 && side < 42,
    `${side.toFixed(0)} km/h sideways on a 20 deg pitch`);
}

console.log(H('3. Skating off the mark, which is not a feature -- it is the contact equation.'));
{
  const pose = makePose({ yaw: deg(90), edge: deg(-38) });
  const shove = new THREE.Vector3(0, 0, -1.8);
  const jab = (t) => (t > 0.3 && t < 0.45 ? shove : null);
  const still = run({ slope: 2, seconds: 1.6, pose });
  const got = run({ slope: 2, seconds: 1.6, pose, push: jab });
  check('the shove moves you', got.r.boardPos.z > still.r.boardPos.z + 0.2,
    `${got.r.boardPos.z.toFixed(2)} m vs ${still.r.boardPos.z.toFixed(2)} m without it`);
  // It tops out at about the speed your feet were moving, which is what the equation says: you
  // cannot push yourself faster than the thing you are pushing against is going.
  check('and tops out near your own hand speed', got.peak > 0.8 && got.peak < 2.6,
    `peaked at ${got.peak.toFixed(2)} m/s against a 1.8 m/s shove`);
  const flat = run({ slope: 2, seconds: 1.6, pose: makePose({ yaw: deg(90), edge: 0 }), push: jab });
  check('a flat base has nothing to push against', flat.peak < got.peak * 0.65,
    `${flat.peak.toFixed(2)} vs ${got.peak.toFixed(2)} m/s`);
}

console.log(H('4. Carving. You swing the board, the slip angle opens, the edge drags you round.'));
{
  // Hold the board still while tilted and it runs nearly straight. That is not a shortfall: a
  // real board carves because it ROTATES through the arc, and if you refuse to rotate it, it does
  // not carve. What it must still do is bite the moment the edge goes in.
  const pinned = turnCost(14, 2, () => makePose({ yaw: 0, edge: deg(45), pitch: deg(14) }));
  check('a pinned edge bites', pinned.peakG > 0.5, `${pinned.peakG.toFixed(2)} g on initiation`);
  check('but a board you refuse to swing runs almost straight', pinned.swing < 15,
    `${pinned.swing.toFixed(0)} deg of heading change in 2 s`);

  const swung = turnCost(14, 2, carve(45, 0.9, 14));
  check('swinging it round carves a real turn', swung.swing > 60, `${swung.swing.toFixed(0)} deg round`);
  check('with a sustained load, not a one-off thump', swung.sustainG > 0.7 && swung.sustainG < 2.2,
    `${swung.sustainG.toFixed(2)} g held for two seconds`);

  // THE point of carving. Both of these turn you; one costs a fraction of what the other does.
  // Measured per degree, because raw speed kept says nothing when one comes round 104 degrees
  // and the other manages 17.
  const skid = turnCost(14, 2, carve(0.001, 0.9, 14));
  check('a carve costs a fraction of a skid, per degree turned', swung.perDeg * 5 < skid.perDeg,
    `${swung.perDeg.toFixed(4)} vs ${skid.perDeg.toFixed(4)} m/s lost per degree`);
  check('and a skid barely turns you at all', skid.swing < swung.swing * 0.4,
    `${skid.swing.toFixed(0)} deg against ${swung.swing.toFixed(0)}`);

  // R = Rsc*cos(psi) is the TIGHTEST arc an edge angle can hold, so swing faster than a shallow
  // edge can follow and it washes out while a deep one still rails. Comparing radii at a shared
  // swing rate proves nothing: there the radius is just v/omega whatever the snow is doing.
  const deep = turnCost(14, 1.5, carve(60, 2.5, 14));
  const shallow = turnCost(14, 1.5, carve(20, 2.5, 14));
  check('a deep edge holds a fast swing', deep.swing > 90, `${deep.swing.toFixed(0)} deg round`);
  check('a shallow one washes out instead', shallow.swing < 50 && shallow.perDeg > deep.perDeg * 3,
    `${shallow.swing.toFixed(0)} deg round at ${shallow.perDeg.toFixed(3)} per degree vs ${deep.perDeg.toFixed(3)}`);
}

console.log(H('5. Both edges work, and they turn opposite ways.'));
{
  const a = turnCost(14, 2, carve(45, 0.9, 14)).r.vel.x;
  const b = turnCost(14, 2, carve(-45, 0.9, 14)).r.vel.x;
  check('mirrored', Math.sign(a) === -Math.sign(b) && Math.abs(Math.abs(a) - Math.abs(b)) < Math.abs(a) * 0.3,
    `${a.toFixed(1)} vs ${b.toFixed(1)} m/s across`);
}

console.log(H('6. Nothing you do with the board may create energy.'));
{
  // The single most valuable assertion in this file. On flat ground there is no gravity to draw
  // on, so whatever you do with your hands, your horizontal speed can only fall.
  //
  // It is here because the model failed it. Holding a steady swing pinned the slip angle at the
  // sidecut's attack angle, where the edge force has a forward component along your travel, and
  // nothing charged for the snow that force was cutting through. Result: on the flat, waggling
  // the board took you from 36 km/h to 41, and windmilling your arms beat riding. The fix is
  // that the along-travel part of the edge force is induced drag and never thrust.
  let worst = { ratio: 0 };
  for (const [name, poseFn] of [
    ['a steady swing on edge', carve(45, 0.9, 0)],
    ['swinging hard', carve(45, 2.2, 0)],
    ['swinging hard on a big edge', carve(60, 3.0, 0)],
    ['swinging against the edge', against(45, 2.2, 0)],
    ['rocking edge to edge', (t) => makePose({ yaw: 0.4 * Math.sin(t * 5), edge: deg(50) * Math.sin(t * 5) })],
    ['flailing', (t) => makePose({ yaw: Math.sin(t * 9) * 1.2, edge: deg(60) * Math.sin(t * 7), pitch: deg(25) * Math.sin(t * 4) })],
  ]) {
    const r = new Rider(planarTerrain(0));
    r.snow = SNOW.groomed;
    r.reset(0, 0, 0, poseFn(0));
    r.vel.set(0, 0, 10);
    const dt = 1 / 240;
    let peak = 10;
    for (let i = 0; i < 10 / dt; i++) {
      r.step(dt, poseFn(i * dt), null, 0, HEAD);
      const h = Math.hypot(r.vel.x, r.vel.z);
      if (h > peak) peak = h;
    }
    const ratio = peak / 10;
    if (ratio > worst.ratio) worst = { ratio, name };
    check(`${name} cannot make you faster`, ratio < 1.01,
      `peaked at ${(ratio * 100).toFixed(1)}% of the speed you started with`);
  }
  console.log(`  (worst case: ${worst.name} at ${(worst.ratio * 100).toFixed(1)}%)`);
}

console.log(H('7. Hockey stop: put the board across your travel, on the uphill edge.'));
{
  const r = new Rider(planarTerrain(14));
  r.snow = SNOW.groomed;
  const flat = flatOnSlope(14, 0);
  r.reset(0, 0, 0, flat);
  const dt = 1 / 240;
  for (let i = 0; i < 4 / dt; i++) r.step(dt, flat, null, 0, HEAD);
  const before = r.speed;
  for (let i = 0; i < 1.5 / dt; i++) r.step(dt, makePose({ yaw: deg(88), edge: deg(-45) }), null, 0, HEAD);
  check('sheds most of the speed in 1.5 s', r.speed < before * 0.5, `${before.toFixed(1)} -> ${r.speed.toFixed(1)} m/s`);
}

console.log(H('8. Ollie: drive the board down, the snow will not move, so you go up.'));
{
  const hard = run({
    slope: 8, seconds: 2.2, pose: makePose({ yaw: 0, edge: 0 }),
    push: (t) => (t > 0.8 && t < 0.95 ? new THREE.Vector3(0, -3.2, 0) : null),
  });
  check('leaves the ground', hard.air > 0.15, `${hard.air.toFixed(2)} s airborne`);
  check('and the height is a real ollie, not a moon jump', (9.81 * hard.air * hard.air) / 8 < 0.7,
    `about ${((9.81 * hard.air * hard.air) / 8).toFixed(2)} m`);

  // A jump is a CONSTRAINT, not a repeated shove. Holding a crouch for a whole second must not
  // accumulate velocity -- that was a real bug in the first version of this model.
  const slow = run({
    slope: 0, seconds: 3, pose: makePose({ yaw: 0, edge: 0 }),
    push: (t) => (t > 0.5 && t < 1.5 ? new THREE.Vector3(0, -1.0, 0) : null),
  });
  check('a held crouch does not accumulate lift', slow.maxVy < 0.8, `topped out at ${slow.maxVy.toFixed(2)} m/s up`);

  const glitch = run({
    slope: 0, seconds: 3, pose: makePose({ yaw: 0, edge: 0 }),
    push: (t) => (t > 0.5 && t < 0.6 ? new THREE.Vector3(0, -14, 0) : null),
  });
  check('an absurd tracking spike is capped', glitch.air < 0.9, `${glitch.air.toFixed(2)} s airborne`);
}

console.log(H('9. Lift the board and you fall; no contact means no grip.'));
{
  const r = new Rider(planarTerrain(10));
  r.snow = SNOW.groomed;
  r.reset(0, 0, 0, makePose({ height: 0.85 }));
  const dt = 1 / 240;
  for (let i = 0; i < 1 / dt; i++) r.step(dt, makePose({ height: 0.85 }), null, 0, HEAD);
  const y0 = r.pos.y;
  for (let i = 0; i < 0.35 / dt; i++) r.step(dt, makePose({ height: 1.25 }), null, 0, HEAD);
  check('rider falls when the board is lifted', r.pos.y < y0 - 0.05, `rig dropped ${(y0 - r.pos.y).toFixed(2)} m`);
}

console.log(H('10. You have a body, and standing on it costs what standing costs.'));
{
  const dt = 1 / 240;
  const r = new Rider(planarTerrain(0));
  r.snow = SNOW.groomed;
  r.reset(0, 0, 0, makePose({ height: 0.85 }));
  for (let i = 0; i < 2 / dt; i++) r.step(dt, makePose({ height: 1.95 }), null, 0, HEAD);
  const snowY = r.terrain.heightAt(r.pos.x, r.pos.z);
  check('your head stays above the snow', r.pos.y + HEAD.y >= snowY + DEFAULT_TUNING.bodyMin - 0.02,
    `head ${(r.pos.y + HEAD.y - snowY).toFixed(2)} m above it`);
  check('the board is genuinely off the ground', r.boardPos.y - snowY > 0.5 && !r.grounded,
    `board ${(r.boardPos.y - snowY).toFixed(2)} m up`);
  check('and the game reports you as standing, not riding', r.standing === true);

  // Holding the board up used to zero your vertical velocity outright, which also deleted every
  // bit of downhill drive and turned it into a frictionless hovercraft that outran riding.
  const ride = new Rider(planarTerrain(12)); ride.snow = SNOW.groomed;
  const stand = new Rider(planarTerrain(12)); stand.snow = SNOW.groomed;
  for (const [rr, h] of [[ride, 0.85], [stand, 1.95]]) {
    rr.reset(0, 0, 0, makePose({ height: h }));
    rr.vel.set(0, 0, 15);
    for (let i = 0; i < 4 / dt; i++) rr.step(dt, makePose({ height: h }), null, 0, HEAD);
  }
  check('standing is slower than riding, not faster', stand.speed < ride.speed * 0.8,
    `standing ${stand.speed.toFixed(1)} m/s vs riding ${ride.speed.toFixed(1)} m/s`);
  // Tight on purpose. A frictionless glide still "loses speed" to air drag, so a loose bound
  // here passes on exactly the bug it exists to catch. Boots biting snow should nearly stop you.
  check('and boots on snow actually brake', stand.speed < 6, `${stand.speed.toFixed(1)} m/s, from 15`);
}

console.log(H('11. Pitch is read against the SNOW, not the horizon, and a buried nose ploughs.'));
{
  const level = run({ slope: 12, seconds: 3.5, pose: makePose({ yaw: 0, edge: 0, pitch: deg(10) }) }).r;
  check('a level board reads as nearly flat on the snow', Math.abs(level.pitchDeg) < 6, `${level.pitchDeg.toFixed(1)} deg to the snow`);
  const dug = run({ slope: 12, seconds: 3.5, pose: makePose({ yaw: 0, edge: 0, pitch: deg(58) }) }).r;
  check('a buried nose costs speed', dug.speed < level.speed - 1.0, `${dug.speed.toFixed(1)} vs ${level.speed.toFixed(1)} m/s`);
  check('and the nose is the part touching', dug.noseGap <= dug.tailGap, `nose ${dug.noseGap.toFixed(2)} m, tail ${dug.tailGap.toFixed(2)} m`);
}

console.log(H('12. An upside-down board has no edge in the snow.'));
{
  // Assert on what MOVES, not on the g reading. A parked board has almost no lateral velocity
  // either way, so the g number barely shifts and the test passes whatever the code does. What
  // actually changes is whether the thing holds you on the hill: an upside-down board must not.
  const flipped = run({ slope: 12, seconds: 3, pose: makePose({ yaw: deg(90), edge: deg(150) }) }).r;
  const set = run({ slope: 12, seconds: 3, pose: makePose({ yaw: deg(90), edge: deg(-40) }) }).r;
  check('rolling past its side does not hold you like a set edge', flipped.speed > set.speed + 0.5,
    `upside down slides at ${flipped.speed.toFixed(2)} m/s, a set edge holds at ${set.speed.toFixed(2)}`);
}

console.log(H('13. The world never turns you, and nothing ends your run.'));
{
  const hard = atSpeed(16, 4, carve(50, 0.9, 16));
  check('the rig yaw never moves through a hard carve', hard.r.yaw === 0, `yaw ${hard.r.yaw}`);

  const drop = new Rider(planarTerrain(20));
  drop.snow = SNOW.groomed;
  drop.reset(0, 0, 0, flatOnSlope(20, 0));
  drop.pos.y += 18;
  const dt = 1 / 240;
  let ok = true;
  for (let i = 0; i < 8 / dt; i++) {
    const p = i * dt > 4 ? makePose({ yaw: deg(75), edge: deg(50), pitch: deg(20) }) : flatOnSlope(20, 0);
    drop.step(dt, p, null, 0, HEAD);
    if (!Number.isFinite(drop.speed) || drop.lastEvent?.type === 'crash') ok = false;
  }
  check('an 18 m drop landed sideways, then the downhill edge: still riding', ok,
    `${drop.speed.toFixed(1)} m/s at the end`);
}

console.log(H('14. The model does not change with the frame rate.'));
{
  // The game runs a fixed 1/120 step and this file used to run everything at 1/240, so a term
  // whose stiffness was 1/dt was being validated at a rate that never ships.
  for (const [name, poseFn] of [
    ['straight running', () => flatOnSlope(16, 0)],
    ['a swung carve', carve(45, 0.9, 16)],
    ['a board parked on its edge', () => makePose({ yaw: deg(90), edge: deg(-35) })],
  ]) {
    const a = run({ slope: 16, seconds: 4, dt: 1 / 120, pose: poseFn }).r;
    const b = run({ slope: 16, seconds: 4, dt: 1 / 240, pose: poseFn }).r;
    const d = Math.abs(a.speed - b.speed) / Math.max(0.5, b.speed);
    check(`${name} agrees between 120 and 240 Hz`, d < 0.1,
      `${a.speed.toFixed(2)} vs ${b.speed.toFixed(2)} m/s (${(d * 100).toFixed(1)}% apart)`);
  }
}

console.log(H('15. Terminal speeds land where the literature says they should.'));
{
  const want = { 10: [50, 70], 20: [80, 100], 30: [100, 125] };
  for (const [slopeStr, [lo, hi]] of Object.entries(want)) {
    const slope = Number(slopeStr);
    const pose = flatOnSlope(slope, 0);
    const r = new Rider(planarTerrain(slope));
    r.snow = SNOW.groomed;
    r.reset(0, 0, 0, pose);
    for (let i = 0; i < 40 * 240; i++) r.step(1 / 240, pose, null, 0, HEAD);
    const kmh = r.speed * 3.6;
    check(`${slope} deg settles in ${lo}-${hi} km/h`, kmh > lo && kmh < hi, `${kmh.toFixed(0)} km/h`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
