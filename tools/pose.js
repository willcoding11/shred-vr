// Builds board poses the way a player's hands would, so the headless harnesses can drive the
// same pose-in, forces-out physics the headset does.
//
// Rig space: +z is the direction the rig faces (which tracks your travel), +y is up.
// `yaw` is the board's heading relative to that, `edge` its roll about its own axis, `pitch`
// nose-down. `height` is where your hands are holding it above the rig floor.
import * as THREE from 'three';

const Y = new THREE.Vector3(0, 1, 0);

export function makePose({ yaw = 0, edge = 0, pitch = 0, height = 0.85, lateral = 0, ahead = 0 } = {}) {
  const nose = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  // lateral axis of the board, used to pitch the nose down
  const side = new THREE.Vector3().crossVectors(nose, Y).normalize();
  if (pitch) nose.applyAxisAngle(side, -pitch).normalize();
  const up = Y.clone().applyAxisAngle(nose, edge);
  up.addScaledVector(nose, -up.dot(nose)).normalize();
  return {
    valid: true,
    center: new THREE.Vector3(lateral, height, ahead),
    nose,
    up,
  };
}

// Degrees are friendlier to write tests in.
export const deg = (d) => (d * Math.PI) / 180;

// A flat plane falling away along +z, for isolating the model from terrain noise.
export function planarTerrain(slopeDeg) {
  const t = Math.tan(deg(slopeDeg)), l = Math.hypot(0, 1, t);
  return {
    heightAt: (x, z) => -t * z,
    normalAt: (x, z, o = [0, 1, 0]) => { o[0] = 0; o[1] = 1 / l; o[2] = t / l; return o; },
    slopeAt: () => slopeDeg,
  };
}

// A board lying genuinely FLAT on a slope at a given heading. Worth having as its own helper,
// because "flat" is not "level with the horizon": a board held level across a 14 degree slope is
// already 14 degrees onto its uphill edge, and tests that confuse the two prove nothing.
export function flatOnSlope(slopeDeg, yawDeg, height = 0.85) {
  const t = Math.tan(deg(slopeDeg)), l = Math.hypot(1, t);
  const up = new THREE.Vector3(0, 1 / l, t / l);
  const dir = new THREE.Vector3(Math.sin(deg(yawDeg)), 0, Math.cos(deg(yawDeg)));
  const nose = dir.addScaledVector(up, -dir.dot(up)).normalize();
  return { valid: true, center: new THREE.Vector3(0, height, 0), nose, up };
}
