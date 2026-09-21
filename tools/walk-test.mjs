// Checks getting around on your hands does what the control scheme promises.
//
// Every case here is something a player physically does with their arms. Nothing calls a move
// function, because there isn't one -- there is only a hand on the snow and a body that has to go
// somewhere. The assertions are written to fail on the ways this goes wrong: a hand that drags you
// along while it is still in the air, a shove that gets stronger the worse your tracking is, and
// hands that fight each other into a jitter. Run: node tools/walk-test.mjs
import * as THREE from '../node_modules/three/build/three.module.js';
import { Walker, WALK_TUNING } from '../public/game/walk.js';
import { planarTerrain } from './pose.js';

let fails = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
};
const flat = { heightAt: () => 0, normalAt: (x, z, o = [0, 1, 0]) => o, slopeAt: () => 0 };
// Hands come in RIG space, and the rig origin is the floor you are standing on -- which is what
// WebXR's local-floor gives you. So a hand reaching down to the snow is near zero, and a hand held
// up out of it is positive. Getting this upside down is why the first run of this file had a hand
// waving in the air dragging the player 49 cm.
const hand = (x, y, z) => ({ pos: new THREE.Vector3(x, y, z) });
const DOWN = 0.0;      // knuckles in the snow
const UP = 0.6;        // clear of it

// Drive a walker with a scripted pair of hands. `script(t)` returns [handA, handB] in rig space.
function run(w, script, secs, dt = 1 / 90) {
  for (let i = 0; i < secs / dt; i++) w.step(dt, script(i * dt));
  return w;
}

console.log('A HAND ON THE SNOW MOVES YOU. A HAND IN THE AIR DOES NOT.');
{
  // Reach forward, plant, and pull back: that is one stroke and it should carry you forward.
  const w = new Walker(flat);
  w.reset(0, 0);
  run(w, (t) => [hand(0, DOWN, 0.5 - t * 1.0), null], 0.5);
  ok(w.pos.z > 0.3, 'pulling a planted hand backwards moves you forwards',
     `${w.pos.z.toFixed(2)} m from a 0.5 m pull`);

  // The same motion with the hand held clear of the snow is just waving.
  const air = new Walker(flat);
  air.reset(0, 0);
  run(air, (t) => [hand(0, UP, 0.5 - t * 1.0), null], 0.5);
  ok(Math.abs(air.pos.z) < 0.01, 'the same stroke in the air does nothing at all',
     `${air.pos.z.toFixed(4)} m`);
  ok(!air.planted[0], 'and that hand never reads as planted');
}

console.log('\nYOU MOVE, THE HAND DOES NOT. THAT IS THE WHOLE MECHANIC.');
{
  const w = new Walker(flat);
  w.reset(0, 0);
  const script = (t) => [hand(0, DOWN, 0.4 - t * 0.8), null];
  run(w, script, 0.5);
  // Wherever the body ended up, the hand it was holding must still be where it took hold.
  const handWorld = script(0.5)[0].pos.clone().add(w.pos);
  ok(Math.abs(handWorld.z - w.anchor[0].z) < 0.02, 'the planted hand stayed where it was put',
     `hand at z ${handWorld.z.toFixed(3)}, anchor ${w.anchor[0].z.toFixed(3)}`);
}

console.log('\nTWO HANDS COOPERATE RATHER THAN FIGHT');
{
  // Both hands pulling together should go about as far as one, not twice as far and not nowhere.
  const one = new Walker(flat); one.reset(0, 0);
  run(one, (t) => [hand(-0.3, DOWN, 0.4 - t * 0.8), null], 0.5);
  const two = new Walker(flat); two.reset(0, 0);
  run(two, (t) => [hand(-0.3, DOWN, 0.4 - t * 0.8), hand(0.3, DOWN, 0.4 - t * 0.8)], 0.5);
  ok(Math.abs(two.pos.z - one.pos.z) < 0.05, 'two hands pulling together go as far as one',
     `${two.pos.z.toFixed(2)} m against ${one.pos.z.toFixed(2)} m`);

  // Hands that disagree average out instead of juddering.
  const split = new Walker(flat); split.reset(0, 0);
  let worst = 0, prev = 0;
  for (let i = 0; i < 45; i++) {
    const t = i / 90;
    split.step(1 / 90, [hand(-0.3, DOWN, 0.4 - t * 0.8), hand(0.3, DOWN, 0.4 - t * 0.5)]);
    worst = Math.max(worst, Math.abs(split.pos.z - prev));
    prev = split.pos.z;
  }
  ok(worst < 0.05, 'hands moving at different speeds do not judder',
     `worst step ${(worst * 100).toFixed(1)} cm`);
}

console.log('\nIT CANNOT BE ABUSED');
{
  // A tracking spike is not a shove.
  const w = new Walker(flat); w.reset(0, 0);
  w.step(1 / 90, [hand(0, DOWN, 0), null]);
  w.step(1 / 90, [hand(0, DOWN, -40), null]);        // a hand that teleported 40 m
  ok(w.speed <= WALK_TUNING.maxPush + 1e-6, 'a teleporting hand is capped, not a rocket',
     `${w.speed.toFixed(1)} m/s`);

  // And you cannot out-run the board by rowing.
  const fast = new Walker(flat); fast.reset(0, 0);
  for (let i = 0; i < 400; i++) {
    const p = (i % 20) / 20;
    fast.step(1 / 90, [hand(0, p < 0.5 ? DOWN : UP, 0.5 - p * 2), null]);
  }
  ok(Math.hypot(fast.vel.x, fast.vel.z) <= WALK_TUNING.maxSpeed + 1e-6,
     'rowing flat out still tops out', `${Math.hypot(fast.vel.x, fast.vel.z).toFixed(1)} m/s`);
}

console.log('\nGRAVITY, AND LANDING ON YOUR FEET');
{
  const w = new Walker(flat);
  w.reset(0, 0, 4);                                  // dropped from four metres
  run(w, () => [null, null], 1.5);
  ok(Math.abs(w.pos.y) < 0.01, 'you fall and you land', `y ${w.pos.y.toFixed(3)}`);
  ok(w.grounded, 'and you read as standing on it');

  // Thrown sideways, a landing takes most of it out of you rather than letting you skate away.
  const thrown = new Walker(flat);
  thrown.reset(0, 0, 2);
  thrown.vel.set(6, 0, 0);
  run(thrown, () => [null, null], 1.2);
  ok(Math.abs(thrown.vel.x) < 6 * 0.5, 'landing scrubs most of your sideways speed',
     `${Math.abs(thrown.vel.x).toFixed(1)} m/s from 6.0`);

  // On a hill you settle onto the surface, not through it and not hovering over it.
  const hill = new Walker(planarTerrain(18));
  hill.reset(0, 0, 6);
  run(hill, () => [null, null], 2.5);
  const ground = planarTerrain(18).heightAt(hill.pos.x, hill.pos.z);
  ok(Math.abs(hill.pos.y - ground) < 0.06, 'and on a slope you end up on the snow',
     `${(hill.pos.y - ground).toFixed(3)} m above it`);
}

console.log(fails ? `\n${fails} WALK CHECK(S) FAILED` : '\nALL WALK CHECKS PASSED');
process.exit(fails ? 1 : 0);
