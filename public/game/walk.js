// Getting around with your hands, for when you are NOT strapped in.
//
// This is the same idea as the board, which is the reason it belongs in this game rather than
// being a borrowed mechanic: the rider is a mass, and the only thing that moves it is a contact.
// Strapped in, the contact is the board's patch in the snow and your controllers are your feet.
// Out of the bindings, the contacts are your hands on the ground and your controllers are hands
// again. Nothing steers you, nothing teleports you, and the world never rotates -- a planted hand
// stays where you put it and your body moves instead, which is the whole mechanic.
//
// The one number that matters: a planted hand is an ANCHOR IN THE WORLD. Each frame the body is
// placed so that the hand is still at the anchor. Push the snow behind you and you go forward,
// because the hand cannot go backward -- you can only move the thing that is free to move.
import * as THREE from 'three';

export const WALK_TUNING = {
  gravity: 8.80,             // the same as the board's, for the same reason
  plantEps: 0.06,            // m below the snow a hand has to reach to take hold
  maxPush: 7.0,              // m/s a single shove may add, so a flailed arm is not a rocket
  maxSpeed: 9.0,             // m/s overall, about a hard sprint
  airDrag: 0.06,             // per second, so a long flight bleeds off rather than sailing
  groundDrag: 2.6,           // per second while sliding on your feet
  standEps: 0.05,            // m of clearance that still counts as standing
  bodyHeight: 1.6,           // m from the rig origin to the head, for the ground check
  slideFriction: 0.55,       // how much of your speed the snow takes when you land on your feet
};

const _w = new THREE.Vector3(), _d = new THREE.Vector3(), _push = new THREE.Vector3();

export class Walker {
  constructor(terrain, tuning = {}) {
    this.terrain = terrain;
    this.t = { ...WALK_TUNING, ...tuning };
    this.pos = new THREE.Vector3();          // rig origin, exactly as the Rider uses it
    this.vel = new THREE.Vector3();
    this.grounded = false;
    this.planted = [false, false];
    // Where each hand took hold, in WORLD space. This is the anchor the body is solved against.
    this.anchor = [new THREE.Vector3(), new THREE.Vector3()];
    this.speed = 0;
  }

  reset(x, z, y = null) {
    this.pos.set(x, y === null ? this.terrain.heightAt(x, z) : y, z);
    this.vel.set(0, 0, 0);
    this.planted = [false, false];
    this.grounded = false;
    this.speed = 0;
  }

  // `hands` is the pair from controls: {pos} in RIG space, or null for a hand that is not tracked.
  // The rig never rotates, so rig space and world space differ by a translation and nothing else.
  step(dt, hands) {
    const t = this.t;

    // ---- what the hands are doing -------------------------------------------------------------
    // Solve the body from the anchors first. A hand that is planted did not move; you did.
    let solved = 0;
    _d.set(0, 0, 0);
    for (let i = 0; i < 2; i++) {
      const h = hands && hands[i];
      if (!h) { this.planted[i] = false; continue; }
      _w.copy(h.pos).add(this.pos);                       // where this hand is in the world
      const ground = this.terrain.heightAt(_w.x, _w.z);
      const touching = _w.y <= ground + t.plantEps;

      if (touching && !this.planted[i]) {
        // Taking hold. The anchor is where the hand actually is, clamped to the surface so you
        // cannot get a purchase on snow you never reached.
        this.planted[i] = true;
        this.anchor[i].set(_w.x, Math.max(_w.y, ground), _w.z);
      } else if (!touching && this.planted[i]) {
        this.planted[i] = false;
      }

      if (this.planted[i]) {
        // Where the body would have to be for this hand to still be at its anchor.
        _d.x += this.anchor[i].x - h.pos.x - this.pos.x;
        _d.y += this.anchor[i].y - h.pos.y - this.pos.y;
        _d.z += this.anchor[i].z - h.pos.z - this.pos.z;
        solved++;
      }
    }

    if (solved) {
      _d.divideScalar(solved);
      // Two hands disagree all the time -- they are on different bits of snow and your arms are
      // not rigid. Averaging is the honest answer, and it is also what stops one hand fighting
      // the other into a jitter.
      this.pos.add(_d);
      // What that move was worth as a velocity. Capped, because a tracking spike is not a shove.
      _push.copy(_d).divideScalar(Math.max(1e-4, dt));
      const mag = _push.length();
      if (mag > t.maxPush) _push.multiplyScalar(t.maxPush / mag);
      // While you are holding on you ARE the push; there is no separate momentum to add to it.
      this.vel.copy(_push);
    } else {
      // ---- nobody is holding on: flight ------------------------------------------------------
      this.vel.y -= t.gravity * dt;
      this.vel.multiplyScalar(Math.max(0, 1 - t.airDrag * dt));
      this.pos.addScaledVector(this.vel, dt);
    }

    // ---- the ground ---------------------------------------------------------------------------
    const floor = this.terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y <= floor + t.standEps) {
      if (!this.grounded && this.vel.y < 0) {
        // Landing on your feet takes most of the sideways speed out of you, which is what stops
        // this being a way to go faster than the board.
        this.vel.x *= 1 - t.slideFriction;
        this.vel.z *= 1 - t.slideFriction;
      }
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
      if (!solved) {
        const k = Math.max(0, 1 - t.groundDrag * dt);
        this.vel.x *= k; this.vel.z *= k;
      }
    } else {
      this.grounded = false;
    }

    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > t.maxSpeed) { const k = t.maxSpeed / sp; this.vel.x *= k; this.vel.z *= k; }
    this.speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
  }
}
