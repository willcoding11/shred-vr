// Rides a map headlessly with a virtual player, so map changes can be checked without a headset.
//
// The virtual player only does what a real one can: it puts the board somewhere in space and
// holds it there. It has no steering function, because the game has no steering function.
//
// Usage:
//   node tools/sim-test.js <mapId> follow|follow_fast     terrain-following rider (the "is it rideable" test)
//   node tools/sim-test.js <mapId> gates|gates_fast       rider that aims for the gates
//   node tools/sim-test.js <mapId> straight               flat board, no input
//   node tools/sim-test.js <mapId> drop <z> <kmh> [secs] [x]   probe one feature at one speed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../node_modules/three/build/three.module.js';
import { deserializeMap, heightAt, normalAt, slopeDegAt, PROP_TYPES, bounds } from '../public/shared/mapformat.js';
import { buildColliders, buildRails, railHeightAt, radiusAt, clears } from '../public/shared/collide.js';
import { setRailSizes } from '../public/shared/collide.js';
// The modelled props, if they have been measured. Without this the sim rides the placeholder rail
// while the game rides the model, and the two disagree in silence.
try {
  const sz = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'sizes.json'), 'utf8'));
  if (sz.rail) setRailSizes(sz.rail);
} catch { /* no modelled props yet */ }
import { Rider, SNOW } from '../public/game/physics.js';
import { makePose, deg } from './pose.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mapId = process.argv[2] || 'first-tracks';
const scenario = process.argv[3] || 'follow';
const map = deserializeMap(fs.readFileSync(path.join(__dirname, '..', 'maps', `${mapId}.json`), 'utf8'));
// Rails, colliders and what hitting one costs all come from the same module the game uses. They
// used to be a second copy here, and the copy carried the same bug: a collider with no height.
const railList = buildRails(map);
const onRail = (x, z) => railList.length && railHeightAt(railList, x, z) > heightAt(map, x, z);
const terrain = {
  heightAt: (x, z) => { const g = heightAt(map, x, z); const r = railHeightAt(railList, x, z); return r > g ? r : g; },
  normalAt: (x, z, o) => { if (onRail(x, z)) { if (o) { o[0] = 0; o[1] = 1; o[2] = 0; return o; } return [0, 1, 0]; } return normalAt(map, x, z, o); },
  slopeAt: (x, z) => (onRail(x, z) ? 0 : slopeDegAt(map, x, z)),
};
const hardProps = buildColliders(map, { hardOnly: true, pad: 0.28 });

const gateList = map.props.filter((p) => p.t === 'gate')
  .map((p) => ({ x: p.x, z: p.z, r: p.r || 0, w: PROP_TYPES.gate.width, passed: false, missed: false }));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const HEAD = new THREE.Vector3(0, 1.6, 0);   // you have a body; it is 1.6 m to your eyes

// ---------------------------------------------------------------- the virtual player
// Holds the board along the direction of travel and rolls it to steer, or swings it across to
// scrub. `aim` returns the world x it wants to be heading toward.
function makePlayer({ aim, vmax = 17 }) {
  let legs = 0.85;        // where the player is holding the board, i.e. how bent their legs are
  let smoothY = null;     // a low-passed memory of the ground height, to absorb bumps against
  return (r) => {
    const p = r.boardPos;
    const ground = terrain.heightAt(p.x, p.z);
    if (smoothY === null) smoothY = ground;
    smoothY += (ground - smoothY) * 0.06;
    // Legs: soak up the difference between the real ground and the smooth line through it.
    // Without this the rider is a rigid pole and every roller throws them into the air.
    const want = THREE.MathUtils.clamp(0.85 + (ground - smoothY), 0.45, 1.25);
    legs += (want - legs) * 0.25;

    const ahead = 26 + r.speed * 1.1;
    // Nothing rotates the rider any more, so the player has to swing the board round in world
    // space themselves -- exactly what a person does with their arms in the headset.
    const travel = r.speed > 1.5 ? Math.atan2(r.vel.x, r.vel.z) : 0;

    // When you run out of speed you straighten up and point down the fall line to get it back,
    // instead of hanging on a big edge and traversing the hill at walking pace forever. A hard
    // edge held across the slope is a brake, and a rider who never lets go of it never arrives.
    const hx = terrain.heightAt(p.x + 2, p.z) - terrain.heightAt(p.x - 2, p.z);
    const hz = terrain.heightAt(p.x, p.z + 2) - terrain.heightAt(p.x, p.z - 2);
    const fall = Math.atan2(-hx, -hz);
    const slow = 1 - THREE.MathUtils.smoothstep(r.speed, 4, 9);
    const aimHead = Math.atan2(aim(r, ahead) - p.x, ahead);
    const err = wrap(aimHead + wrap(fall - aimHead) * slow - travel);

    // Match the board's pitch to the slope along its OWN length, the way ankles do, so the
    // tail is not ploughing.
    const pitchAt = (yaw) => {
      const dx = Math.sin(yaw) * 3, dz = Math.cos(yaw) * 3;
      return Math.atan2(terrain.heightAt(p.x - dx, p.z - dz) - terrain.heightAt(p.x + dx, p.z + dz), 6);
    };

    // In the air, flatten the board and line it up with where you are going, or you land
    // sideways. Every rider learns this one early.
    if (!r.grounded) return makePose({ yaw: travel, edge: 0, pitch: deg(8), height: legs });

    if (r.speed > vmax) {
      const dir = Math.sign(err) || 1;
      const yaw = travel + deg(62) * dir;
      return makePose({ yaw, edge: deg(-42) * dir, pitch: pitchAt(yaw), height: legs });
    }
    // Roll to carve, and point the nose into the turn as you go: an edge alone only swings your
    // travel a few degrees before it settles, so the turn has to be steered round by hand.
    const cap = deg(THREE.MathUtils.lerp(58, 20, slow));
    const edge = THREE.MathUtils.clamp(-err * 3.2, -cap, cap);
    const yaw = travel + THREE.MathUtils.clamp(err, -deg(30), deg(30));
    return makePose({ yaw, edge, pitch: pitchAt(yaw), height: legs });
  };
}

// The lowest point across the corridor a little way ahead: this is how a person reads a gully.
const followAim = (r, ahead) => {
  const z = r.boardPos.z + ahead;
  let bestX = r.boardPos.x, bestY = Infinity;
  for (let dx = -40; dx <= 40; dx += 2.5) {
    const x = r.boardPos.x + dx;
    const y = terrain.heightAt(x, z) + Math.abs(dx) * 0.012;
    if (y < bestY) { bestY = y; bestX = x; }
  }
  return bestX;
};
// Pure pursuit: aim at the point on the line to the next gate that is `ahead` metres away,
// not at the gate itself. Aiming straight at a gate 80 m down the hill makes the rider commit
// far too early, arrive wide, and then have to come back -- which says nothing about the map.
const gateAim = (r, ahead) => {
  const g = gateList.find((q) => !q.passed && !q.missed && q.z > r.boardPos.z + 2);
  if (!g) return map.finish.x;
  const dz = Math.max(1, g.z - r.boardPos.z);
  const frac = Math.min(1, ahead / dz);
  return r.boardPos.x + (g.x - r.boardPos.x) * frac;
};

// ---------------------------------------------------------------- run
function run(name, player, { seconds = 150, startAt = null, startKmh = null, realism = 'real', rowSecs = 2 } = {}) {
  for (const g of gateList) { g.passed = g.missed = false; }
  const sx = startAt ? (startAt.x ?? 0) : map.start.x;
  const sz = startAt ? startAt.z : map.start.z;
  const r = new Rider(terrain);
  r.snow = SNOW[map.env.snowType] || SNOW.groomed;
  const pose0 = makePose({ height: 0.85 });
  r.reset(sx, sz, map.start.yaw || 0, pose0);
  if (startKmh != null) r.vel.set(Math.sin(r.yaw), 0, Math.cos(r.yaw)).multiplyScalar(startKmh / 3.6);

  const dt = 1 / 120, rows = [];
  let maxSpeed = 0, maxG = 0, air = 0, t = 0, thisAir = 0, longestAir = 0;
  const events = [];
  let prevX = sx, prevZ = sz, walls = 0, hits = 0, lastHit = null, lastHitAt = -9;

  for (let i = 0; i < seconds * 120; i++) {
    t = i * dt;
    r.step(dt, player(r), null, 0, HEAD);
    if (r.lastEvent) {
      events.push({ t: +t.toFixed(2), ...r.lastEvent });
    }
    const bb = bounds(map), p = r.boardPos;
    if (p.x < bb.minX + 2.5) { r.pos.x += (bb.minX + 2.5) - p.x; r.vel.x = Math.abs(r.vel.x) * 0.3; walls++; }
    if (p.x > bb.maxX - 2.5) { r.pos.x -= p.x - (bb.maxX - 2.5); r.vel.x = -Math.abs(r.vel.x) * 0.3; walls++; }
    // Match the game: hitting something solid stops you dead and shoves you clear, it does not
    // end the run. A harness that ends the run instead reports "unrideable" for a map you would
    // actually finish, just slower and crosser.
    {
      const hit = hardProps.find((q) => !clears(q, p.y) && Math.hypot(q.x - p.x, q.z - p.z) < radiusAt(q, p.y));
      if (hit && (hit !== lastHit || t - lastHitAt > 0.4)) {
        if (r.speed > 3.5) events.push({ t: +t.toFixed(2), type: 'hit', kind: hit.t, speed: +r.speed.toFixed(1) });
        const d = Math.hypot(hit.x - p.x, hit.z - p.z) || 1;
        const hr = radiusAt(hit, p.y);
        r.pos.x -= ((hit.x - p.x) / d) * (hr + 0.35 - d);
        r.pos.z -= ((hit.z - p.z) / d) * (hr + 0.35 - d);
        r.vel.multiplyScalar(0.12);
        lastHit = hit; lastHitAt = t; hits++;
      }
    }
    for (const g of gateList) {
      if (g.passed || g.missed) continue;
      const c = Math.cos(g.r), s = Math.sin(g.r);
      const lx = (p.x - g.x) * c - (p.z - g.z) * s, lz = (p.x - g.x) * s + (p.z - g.z) * c;
      const plz = (prevX - g.x) * s + (prevZ - g.z) * c;
      if (plz < 0 && lz >= 0 && Math.abs(lx) <= g.w / 2) g.passed = true;
      if (lz > 4 && !g.passed) g.missed = true;
    }
    if (p.z >= map.finish.z && !events.some((e) => e.type === 'finish')) {
      events.push({ t: +t.toFixed(2), type: 'finish', kmh: +(r.speed * 3.6).toFixed(0), x: +p.x.toFixed(1), inBanner: Math.abs(p.x - map.finish.x) <= map.finish.w / 2 + 1 });
    }
    prevX = p.x; prevZ = p.z;
    maxSpeed = Math.max(maxSpeed, r.speed); maxG = Math.max(maxG, Math.abs(r.lateralG));
    if (!r.grounded) { air += dt; thisAir += dt; if (thisAir > longestAir) longestAir = thisAir; } else thisAir = 0;
    if (i % Math.round(120 * rowSecs) === 0) {
      rows.push({
        t: t.toFixed(0), x: p.x.toFixed(1), z: p.z.toFixed(1), kmh: (r.speed * 3.6).toFixed(0),
        edge: r.edgeDeg.toFixed(0), pitch: r.pitchDeg.toFixed(0), slip: (r.slip * 57.3).toFixed(0),
        g: r.lateralG.toFixed(2), carve: r.carving.toFixed(2), gnd: r.grounded ? 1 : 0,
        slope: terrain.slopeAt(p.x, p.z).toFixed(0),
      });
    }
    if (p.z > map.finish.z + 30) break;
  }
  console.log(`\n=== ${name} on ${map.name} ===`);
  console.table(rows);
  const passed = gateList.filter((g) => g.passed).length, missed = gateList.filter((g) => g.missed).length;
  console.log(`max ${(maxSpeed * 3.6).toFixed(0)} km/h, max ${maxG.toFixed(2)} g, air ${air.toFixed(1)} s, longest air ${longestAir.toFixed(2)} s, ${hits} hit(s), end z ${r.boardPos.z.toFixed(0)} m at t=${t.toFixed(1)} s, gates ${passed}/${gateList.length} (missed ${missed})`);
  const shown = events.filter((e) => e.type !== 'land').slice(0, 12);
  if (shown.length) console.log('events:', JSON.stringify(shown), walls ? `+${walls} wall bumps` : '');
  return { maxSpeed, maxG, air, longestAir, hits, events, endZ: r.boardPos.z, t, passed, missed };
}

const scenarios = {
  follow: () => run('terrain-following rider', makePlayer({ aim: followAim, vmax: 17 })),
  follow_fast: () => run('terrain-following rider, reckless', makePlayer({ aim: followAim, vmax: 24 })),
  gates: () => run('rider aiming for the gates', makePlayer({ aim: gateAim, vmax: 15 })),
  gates_fast: () => run('rider aiming for the gates, fast', makePlayer({ aim: gateAim, vmax: 24 })),
  straight: () => run('flat board, no input', () => makePose({ yaw: 0, edge: 0, height: 0.85 })),
  carve: () => run('alternating edges, 3 s apart', (r) => makePose({ yaw: 0, edge: deg(Math.sin(r.time / 3 * Math.PI) > 0 ? 45 : -45), height: 0.85 })),
};

if (scenario === 'drop') {
  const z = Number(process.argv[4] || 100), kmh = Number(process.argv[5] || 50);
  const secs = Number(process.argv[6] || 8), x = Number(process.argv[7] || 0);
  run(`drop-in at (${x}, ${z}) m, ${kmh} km/h, flat board`,
    () => makePose({ yaw: 0, edge: 0, height: 0.85 }),
    { seconds: secs, startAt: { x, z }, startKmh: kmh, rowSecs: 0.5 });
} else if (scenario === 'all') {
  for (const k of ['straight', 'carve', 'follow', 'gates']) scenarios[k]();
} else if (scenarios[scenario]) scenarios[scenario]();
else { console.error(`unknown scenario "${scenario}"`); process.exit(1); }
