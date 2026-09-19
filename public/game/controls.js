// "Your hands are your feet", taken literally.
//
// Each controller IS a binding. Where the controller is in the room is where that foot is, so
// the board is a rigid body spanning between them and you can put it anywhere in 3D: lift it,
// stand it on edge, swing the nose around, press the tail down. Nothing here interprets your
// motion into abstract "steer" or "edge" numbers -- it reports where the board is, and the
// physics reads the geometry off the snow.
//
// One consequence worth knowing: the board ends up at hand height, so the snow surface is at
// hand height too, and your head sits only ~0.8 m above it. That closeness is the point.
import * as THREE from 'three';
import { boardFrame, rollOf, combineRoll, upFromRoll, applyGain } from '../shared/boardpose.js';

const Y = new THREE.Vector3(0, 1, 0);
const _rawVel = new THREE.Vector3();

// A board pose in rig space. `center` is the midpoint between the bindings; `nose` runs from
// the back foot to the front foot; `up` is perpendicular to it, out of the deck.
export class BoardPose {
  constructor() {
    this.center = new THREE.Vector3();
    this.nose = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.valid = false;
  }
  copy(o) { this.center.copy(o.center); this.nose.copy(o.nose); this.up.copy(o.up); this.valid = o.valid; return this; }
}

export class BoardControls {
  constructor(renderer, rig, opts = {}) {
    this.renderer = renderer;
    this.rig = rig;
    this.settings = {
      regular: true,          // regular = left foot (left hand) forward
      rollGain: 1.0,          // 1 = the board rolls exactly as much as your wrists do
      smoothing: 0.06,        // seconds of lag on the pose; tracking noise is real
      ...opts,
    };
    this.hands = [null, null];
    this.head = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1) };
    this.pose = new BoardPose();          // smoothed, what the physics reads
    this.rawPose = new BoardPose();       // this frame, unsmoothed
    this.calib = null;
    this._tmp4 = new THREE.Vector3(); this._tmp5 = new THREE.Vector3();
    this.handVel = new THREE.Vector3();   // centroid velocity of the two hands (rig space)
    this.stanceWidth = 0.5;
    this.sources = [];
    this.buttons = { trigger: [false, false], grip: [false, false], a: false, b: false, x: false, y: false };
    this.prevButtons = { trigger: [false, false], grip: [false, false], a: false, b: false, x: false, y: false };
    this.pressed = { trigger: [false, false], grip: [false, false], a: false, b: false, x: false, y: false };
    this._tmp = new THREE.Vector3(); this._tmp2 = new THREE.Vector3(); this._tmp3 = new THREE.Vector3();
    this._qi = new THREE.Quaternion();
    this.setupXR();
  }

  setupXR() {
    const xr = this.renderer.xr;
    for (let i = 0; i < 2; i++) {
      const grip = xr.getControllerGrip(i);
      const hand = xr.getHand(i);
      this.rig.add(grip, hand);
      grip.addEventListener('connected', (e) => { grip.userData.source = e.data; });
      grip.addEventListener('disconnected', () => { grip.userData.source = null; });
      hand.addEventListener('connected', (e) => { hand.userData.source = e.data; });
      hand.addEventListener('disconnected', () => { hand.userData.source = null; });
      this.sources.push({ grip, hand });
    }
  }

  get frontIndex() { return this.settings.regular ? 0 : 1; }   // regular: left hand leads

  update(dt, camera) {
    camera.getWorldPosition(this._tmp); this.rig.worldToLocal(this._tmp); this.head.pos.copy(this._tmp);
    camera.getWorldDirection(this._tmp2);
    this._qi.copy(this.rig.quaternion).invert();
    this.head.fwd.copy(this._tmp2).applyQuaternion(this._qi);
    this.head.fwd.y = 0;
    if (this.head.fwd.lengthSq() < 1e-6) this.head.fwd.set(0, 0, -1); else this.head.fwd.normalize();

    const seen = [false, false];
    for (let i = 0; i < 2; i++) {
      const { grip, hand } = this.sources[i];
      let obj = null, src = null;
      if (hand.userData.source && hand.joints && hand.joints['wrist']) { obj = hand.joints['wrist']; src = hand.userData.source; }
      else if (grip.userData.source) { obj = grip; src = grip.userData.source; }
      if (!obj || !src) continue;
      const h = src.handedness === 'left' ? 0 : src.handedness === 'right' ? 1 : i;
      const rec = this.hands[h] || (this.hands[h] = {
        pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
        prev: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0,
      });
      rec.prev.copy(rec.pos);
      rec.pos.copy(obj.position); rec.quat.copy(obj.quaternion);
      if (rec.age > 0) rec.vel.subVectors(rec.pos, rec.prev).multiplyScalar(1 / Math.max(dt, 1e-3));
      rec.age += dt;
      seen[h] = true;
      this.readButtons(h, src, hand);
    }
    for (let i = 0; i < 2; i++) if (!seen[i]) this.hands[i] = null;
    this.edgeButtons();

    if (!this.hands[0] || !this.hands[1]) { this.rawPose.valid = false; this.pose.valid = false; return this.pose; }
    this.computePose(dt);
    return this.pose;
  }

  readButtons(h, src, hand) {
    const gp = src.gamepad;
    if (gp) {
      const b = gp.buttons;
      this.buttons.trigger[h] = !!b[0]?.pressed;
      this.buttons.grip[h] = !!b[1]?.pressed;
      if (h === 1) { this.buttons.a = !!b[4]?.pressed; this.buttons.b = !!b[5]?.pressed; }
      else { this.buttons.x = !!b[4]?.pressed; this.buttons.y = !!b[5]?.pressed; }
      return;
    }
    if (!hand.userData.source) return;
    // Hand tracking: pinches stand in for buttons, with hysteresis so a fingertip hovering near
    // the threshold does not chatter, and a closed fist is ignored (bracing curls every finger).
    const J = hand.joints, thumb = J['thumb-tip'];
    const held = (this._pinch ||= [{}, {}])[h];
    const pinched = (name) => {
      const tip = J[name];
      const d = tip && thumb ? tip.position.distanceTo(thumb.position) : 99;
      const on = held[name] ? d < 0.030 : d < 0.018;
      held[name] = on;
      return on;
    };
    const idx = pinched('index-finger-tip'), mid = pinched('middle-finger-tip');
    const rng = pinched('ring-finger-tip'), pky = pinched('pinky-finger-tip');
    const fist = [idx, mid, rng, pky].filter(Boolean).length >= 3;
    this.buttons.trigger[h] = idx && !fist;
    const menu = mid && !idx && !fist, gate = rng && !idx && !fist, rest = pky && !idx && !fist;
    if (h === 1) { this.buttons.b = menu; this.buttons.a = gate; }
    else { this.buttons.y = menu; this.buttons.x = gate; }
    this.buttons.grip[h] = rest;
  }

  edgeButtons() {
    for (const k of ['a', 'b', 'x', 'y']) { this.pressed[k] = this.buttons[k] && !this.prevButtons[k]; this.prevButtons[k] = this.buttons[k]; }
    for (let i = 0; i < 2; i++) {
      this.pressed.trigger[i] = this.buttons.trigger[i] && !this.prevButtons.trigger[i]; this.prevButtons.trigger[i] = this.buttons.trigger[i];
      this.pressed.grip[i] = this.buttons.grip[i] && !this.prevButtons.grip[i]; this.prevButtons.grip[i] = this.buttons.grip[i];
    }
  }

  // Capture the neutral pose: whatever you are holding right now becomes "board flat".
  // Only the ROLL reference is captured. Position and heading are always read live, because
  // the whole point is that where your hands are is where the board is.
  calibrate() {
    const front = this.hands[this.frontIndex], back = this.hands[1 - this.frontIndex];
    if (!front || !back) return false;
    const nose = this._tmp.subVectors(front.pos, back.pos);
    if (nose.length() < 0.08) return false;
    nose.normalize();
    // "Flat" means the deck faces world up, so take world up perpendicular to the board axis
    // and remember it in each controller's own frame. Wrist roll from here rolls the board.
    const upRef = this._tmp2.copy(Y).addScaledVector(nose, -Y.dot(nose)).normalize();
    this.calib = {
      localUp: this.hands.map((h) => upRef.clone().applyQuaternion(h.quat.clone().invert())),
      width: front.pos.distanceTo(back.pos),
      centerY: (front.pos.y + back.pos.y) / 2,
    };
    return true;
  }

  computePose(dt) {
    const front = this.hands[this.frontIndex], back = this.hands[1 - this.frontIndex];
    const raw = this.rawPose;

    // Position and heading come straight from where the controllers are, in full 3D.
    raw.center.addVectors(front.pos, back.pos).multiplyScalar(0.5);
    const nose = this._tmp.subVectors(front.pos, back.pos);
    const len = nose.length();
    if (len < 0.05) { raw.valid = false; this.pose.valid = false; return; }
    nose.multiplyScalar(1 / len);
    raw.nose.copy(nose);

    // Roll about that axis: average what each wrist has done since calibration. The awkward part
    // of this -- and it is genuinely awkward, see the module -- lives in boardpose.js.
    const { flat, ref } = boardFrame(nose, this._tmp2, this._tmp4);
    let ang = 0;
    if (this.calib) {
      let a0 = null, a1 = null;
      for (let i = 0; i < 2; i++) {
        this._tmp3.copy(this.calib.localUp[i]).applyQuaternion(this.hands[i].quat);
        const aa = rollOf(nose, this._tmp3, flat, ref);
        if (i === 0) a0 = aa; else a1 = aa;
      }
      ang = combineRoll(a0, a1);
    }
    // optional gain: >1 turns a small wrist roll into a bigger edge angle
    ang = applyGain(ang, this.settings.rollGain);
    const up = upFromRoll(nose, flat, ang, this._tmp5);
    raw.up.copy(up);
    raw.valid = true;

    // Light low-pass: hand tracking is noisy and the physics reads angles off this directly.
    const k = this.settings.smoothing > 0 ? Math.min(1, dt / this.settings.smoothing) : 1;
    if (!this.pose.valid) this.pose.copy(raw);
    else {
      this.pose.center.lerp(raw.center, k);
      this.pose.nose.lerp(raw.nose, k); this.pose.nose.normalize();
      this.pose.up.lerp(raw.up, k);
      this.pose.up.addScaledVector(this.pose.nose, -this.pose.up.dot(this.pose.nose));
      if (this.pose.up.lengthSq() < 1e-6) this.pose.up.copy(raw.up); else this.pose.up.normalize();
      this.pose.valid = true;
    }

    // How fast the feet are driving the board. Raw per-frame deltas are far too noisy to hand
    // to the physics -- tracking jitter alone would read as a pop several times a second -- so
    // this is low-passed on the same time constant as the pose.
    _rawVel.addVectors(front.vel, back.vel).multiplyScalar(0.5);
    this.handVel.lerp(_rawVel, k);
    this.stanceWidth = len;
  }
}
