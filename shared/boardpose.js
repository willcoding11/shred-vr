// How far the board is rolled about its own axis, given what each wrist is doing.
//
// This is its own module because it is the one piece of the control scheme with a numerical trap
// in it, and a trap that only shows up in a headset is a trap nobody finds. tools/pose-test.mjs
// drives it directly.
import * as THREE from 'three';

const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));

// A reference frame around the board axis: `flat` is where the deck points when the board is flat,
// `ref` completes the pair so a roll is just an angle between them.
export function boardFrame(nose, flat = _f, ref = _r) {
  flat.copy(Y).addScaledVector(nose, -Y.dot(nose));
  if (flat.lengthSq() < 1e-8) {
    // The nose is straight up or down, so world up gives no reference at all. Any perpendicular
    // will do -- the roll is genuinely undefined here, and what matters is that it does not jump.
    flat.set(1, 0, 0).addScaledVector(nose, -nose.x);
    if (flat.lengthSq() < 1e-8) flat.set(0, 0, 1).addScaledVector(nose, -nose.z);
  }
  flat.normalize();
  ref.crossVectors(nose, flat);
  return { flat, ref };
}

// The roll of one wrist's up-vector about the board axis, or null if that wrist has nothing to
// say (its up has ended up along the axis, where the angle is meaningless).
export function rollOf(nose, up, flat, ref) {
  _u.copy(up).addScaledVector(nose, -up.dot(nose));
  if (_u.lengthSq() < 1e-6) return null;
  return Math.atan2(_u.dot(ref), _u.dot(flat));
}

// Combine both wrists. AS ANGLES, not as vectors.
//
// Summing the two up-vectors and normalising looks equivalent, and is -- right up until the wrists
// disagree. The sum of two unit vectors 170 degrees apart is 0.087 long, so tracking noise on it
// comes out amplified about eleven times, and at 180 it collapses to nothing.
//
// That is not a corner case, it is what spreading your hands apart does: to hold the controllers
// wide, your forearms rotate outward in OPPOSITE senses, so the two wrist-ups swing apart. The
// board went flat as they approached opposition, and then a centimetre of hand movement stood it
// on edge. Averaged as angles there is no collapse and no amplification.
export function combineRoll(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return b;
  if (b === null) return a;
  return a + wrap(b - a) * 0.5;
}

// The finished deck direction: `flat`, rolled about the board axis by the combined angle.
export function upFromRoll(nose, flat, ang, out) {
  return out.copy(flat).applyAxisAngle(nose, ang);
}

export const MAX_ROLL = 1.45;      // about 83 degrees; past this the board is on its rail anyway
const KNEE = 1.20;                 // 69 degrees, where the hard clamp starts to be felt

// Apply the roll gain, easing into the limit instead of slamming against it.
//
// A hard clamp is why "a slight adjustment" could put the board at ninety degrees: with the gain
// at 1.6, a 52 degree wrist roll already multiplies past the stop, so everything from there
// upward pinned at the same maximum and the last few degrees of wrist did nothing -- then the
// travel just before it covered a huge range. Below the knee this is exactly what it always was;
// above it the remaining 14 degrees take progressively more wrist and the limit is approached
// rather than hit.
export function applyGain(ang, gain) {
  const a = ang * gain, m = Math.abs(a);
  if (m <= KNEE) return a;
  const t = (m - KNEE) / (MAX_ROLL - KNEE);
  return Math.sign(a) * (KNEE + (MAX_ROLL - KNEE) * Math.tanh(t));
}
export { wrap };
