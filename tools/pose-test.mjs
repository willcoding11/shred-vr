// The board-roll maths, driven directly. Run: node tools/pose-test.mjs
//
// Written to chase a report that "moving your hands farther apart makes the board much more flat,
// and a slight adjustment then puts it at 90 degrees". The first guess -- that averaging the two
// wrist up-vectors amplifies noise as they approach opposition -- is WRONG, and the conditioning
// section below is what disproved it: the direction of a sum of two unit vectors is their
// bisector no matter how short the sum gets. What is real is the collapse at exact opposition,
// and the separation coupling measured at the bottom.
import * as THREE from 'three';
import { boardFrame, rollOf, combineRoll, upFromRoll } from '../public/shared/boardpose.js';

const Y = new THREE.Vector3(0, 1, 0);
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
let fails = 0;
const ok = (c, label, detail = '') => { if (!c) fails++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`); };

const nose0 = new THREE.Vector3(0, 0, 1);
const F0 = boardFrame(nose0, new THREE.Vector3(), new THREE.Vector3());
const wristUp = (a) => F0.flat.clone().applyAxisAngle(nose0, a);
const newWay = (a0, a1) => combineRoll(rollOf(nose0, wristUp(a0), F0.flat, F0.ref), rollOf(nose0, wristUp(a1), F0.flat, F0.ref));

console.log('AGREEING WRISTS');
for (const d of [0, 10, 25, 40, -30]) {
  ok(Math.abs(deg(newWay(rad(d), rad(d))) - d) < 0.01, `both wrists at ${d} deg`);
}
ok(Math.abs(deg(newWay(rad(20), rad(40))) - 30) < 0.01, 'wrists at 20 and 40 give the midpoint');

console.log('');
console.log('DISAGREEING WRISTS: the old vector average vs the new angle average');
console.log('  Both give the bisector. The difference is only what happens as the sum vanishes.');
console.log('  disagree   old |sum|   old result   new result');
{
  const oldWay = (a0, a1) => {
    const up = wristUp(a0).add(wristUp(a1)).multiplyScalar(0.5);
    up.addScaledVector(nose0, -up.dot(nose0));
    const len = up.length();
    // this is the branch the old code had, and it means "give up and lie flat"
    if (up.lengthSq() < 1e-6) return { len, txt: 'FLAT (gave up)' };
    up.normalize();
    return { len, txt: `${deg(Math.atan2(up.dot(F0.ref), up.dot(F0.flat))).toFixed(1)} deg` };
  };
  for (const d of [0, 90, 170, 179.9, 180]) {
    const a0 = rad(-d / 2), a1 = rad(d / 2);
    const o = oldWay(a0, a1);
    console.log(`  ${String(d).padStart(6)} deg ${o.len.toFixed(4).padStart(10)} ${o.txt.padStart(14)} ${(deg(newWay(a0, a1)).toFixed(1) + ' deg').padStart(12)}`);
  }
  const o = oldWay(rad(-90), rad(90));
  ok(o.len < 1e-6, 'at exact opposition the old sum vanishes and it falls back to dead flat');
  ok(Number.isFinite(newWay(rad(-90), rad(90))), 'the new way still returns a definite angle');
}

console.log('');
console.log('CONDITIONING: tracking noise on each wrist, at various disagreements');
console.log('  This is the check that killed the amplification theory -- the two are identical.');
{
  const mkRng = (seed) => { let x = seed; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
  const jit = (v, amp, rng) => v.clone().applyAxisAngle(
    new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(), (rng() - 0.5) * 2 * amp);
  const oldV = (u0, u1) => {
    const up = u0.clone().add(u1).multiplyScalar(0.5);
    up.addScaledVector(nose0, -up.dot(nose0));
    if (up.lengthSq() < 1e-6) return 0;
    up.normalize();
    return Math.atan2(up.dot(F0.ref), up.dot(F0.flat));
  };
  const newV = (u0, u1) => combineRoll(rollOf(nose0, u0, F0.flat, F0.ref), rollOf(nose0, u1, F0.flat, F0.ref));
  const spread = (d, which) => {
    const rng = mkRng(99), vals = [];
    for (let k = 0; k < 600; k++) vals.push(deg(which(jit(wristUp(rad(-d / 2)), rad(1), rng), jit(wristUp(rad(d / 2)), rad(1), rng))));
    const m = vals.reduce((p, c) => p + c, 0) / vals.length;
    return Math.sqrt(vals.reduce((p, c) => p + (c - m) ** 2, 0) / vals.length);
  };
  console.log('  disagree   old spread   new spread');
  let worst = 0;
  for (const d of [0, 90, 170, 178]) {
    const o = spread(d, oldV), n = spread(d, newV);
    worst = Math.max(worst, n);
    console.log(`  ${String(d).padStart(6)} deg ${o.toFixed(2).padStart(11)} ${n.toFixed(2).padStart(12)}`);
  }
  ok(worst < 0.6, 'one degree of wrist noise is well under a degree of board roll', `${worst.toFixed(2)} deg`);
}

console.log('');
console.log('SEPARATION: spreading your hands WITHOUT moving your wrists');
console.log('  Calibrated at 0.60 m apart, then the hands move apart with the controller');
console.log('  orientations held fixed. Any change here is the code, not your wrists.');
{
  // the real pipeline: calibrate, then read
  const mkCalib = (pF, pB, qF, qB) => {
    const nose = pF.clone().sub(pB).normalize();
    const upRef = Y.clone().addScaledVector(nose, -Y.dot(nose)).normalize();
    return [upRef.clone().applyQuaternion(qF.clone().invert()), upRef.clone().applyQuaternion(qB.clone().invert())];
  };
  const read = (calib, pF, pB, qF, qB) => {
    const nose = pF.clone().sub(pB).normalize();
    const f = boardFrame(nose, new THREE.Vector3(), new THREE.Vector3());
    const uF = calib[0].clone().applyQuaternion(qF), uB = calib[1].clone().applyQuaternion(qB);
    return deg(combineRoll(rollOf(nose, uF, f.flat, f.ref), rollOf(nose, uB, f.flat, f.ref)));
  };
  // Calibrate FLAT, then hold a 30 degree edge. Calibrating with the edge already on would define
  // it as neutral and every reading would be zero, which tests nothing.
  const qFlat = new THREE.Quaternion();
  const q = new THREE.Quaternion().setFromAxisAngle(nose0, rad(30));
  for (const label of ['hands level (spread along the board)', 'one hand 6 cm higher', 'one hand 6 cm forward']) {
    const off = label.includes('higher') ? new THREE.Vector3(0, 0.06, 0)
      : label.includes('forward') ? new THREE.Vector3(0.06, 0, 0) : new THREE.Vector3();
    const calib = mkCalib(new THREE.Vector3(0, 0, 0.3).add(off), new THREE.Vector3(0, 0, -0.3), qFlat, qFlat);
    const at = (sep) => read(calib, new THREE.Vector3(0, 0, sep / 2).add(off), new THREE.Vector3(0, 0, -sep / 2), q, q);
    const base = at(0.6);
    void qFlat;
    const row = [0.6, 0.8, 1.0, 1.2].map((s) => `${s.toFixed(1)}m:${at(s).toFixed(1)}`).join('  ');
    const drift = Math.max(...[0.8, 1.0, 1.2].map((s) => Math.abs(at(s) - base)));
    console.log(`  ${label.padEnd(38)} ${row}   drift ${drift.toFixed(2)} deg`);
    ok(drift < 0.5, `separation barely moves the roll -- ${label}`, `${drift.toFixed(2)} deg over 60 cm of spread`);
  }
}

console.log('');
console.log('NOSE STRAIGHT UP: the reference frame must not blow up');
{
  const f = boardFrame(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), new THREE.Vector3());
  ok(Math.abs(f.flat.length() - 1) < 1e-6, 'flat is a unit vector');
  ok(Math.abs(f.flat.y) < 1e-6, 'and perpendicular to the board axis');
  ok(Math.abs(f.ref.length() - 1) < 1e-6, 'ref is a unit vector');
}

console.log('');
console.log('ROUND TRIP');
{
  let worst = 0;
  for (let d = -80; d <= 80; d += 7) {
    const u = upFromRoll(nose0, F0.flat, rad(d), new THREE.Vector3());
    worst = Math.max(worst, Math.abs(deg(rollOf(nose0, u, F0.flat, F0.ref)) - d));
  }
  ok(worst < 1e-6, 'roll -> up -> roll is exact', `worst ${worst.toExponential(1)} deg`);
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL POSE CHECKS PASSED');
process.exit(fails ? 1 : 0);
