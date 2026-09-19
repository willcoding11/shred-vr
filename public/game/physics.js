// Snowboard physics. Everything here is a force acting on a mass.
//
// There is no steering, no yaw servo, no turn budget and no scripted move. The rider is a point
// mass; the board is a rigid plate held wherever your hands are; the only coupling between them
// is the contact patch. Every behaviour the game has -- carving, skating off the mark, ollies,
// hockey stops, sideslipping -- falls out of that one contact, because all of them are the same
// contact under different geometry.
//
// The single idea that makes this work is that forces are computed from the velocity of the
// CONTACT PATCH, not the velocity of the rider:
//
//     v_contact = v_rider + v_board_relative_to_rider
//
// Your feet are on the board, so moving your feet moves the contact patch through the snow. Shove
// a gripping edge backwards and the snow shoves the rider forwards. That is not a "skate start"
// feature, it is just what the contact equation says, exactly as in life.
//
// Real relations used:
//   Edge force        F = mu_lat * N,  mu_lat ~ tan(psi)      (Howe; Komissarov)
//   Carved radius     R = Rsc * cos(psi)                      (Komissarov)
//   Sidecut attack    beta_sc = asin(L / 2R)                  (geometry of a bent edge)
//   Tyre-like grip    F_lat = -F_max * tanh(beta / beta_peak) (saturating slip-angle curve)
//   Turn loading      N = m * sqrt((g cos a)^2 + a_lat^2)     (why a hard carve grips harder)
//   Base friction     mu = 0.03..0.08 by snow type            (2021 field data)
//   Air drag          F = 0.5 * rho * CdA * v^2
import * as THREE from 'three';

export const SNOW = {
  groomed: { mu: 0.034, grip: 1.00, label: 'Groomed' },
  powder:  { mu: 0.060, grip: 0.80, label: 'Powder' },
  ice:     { mu: 0.024, grip: 0.55, label: 'Icy' },
  spring:  { mu: 0.068, grip: 0.92, label: 'Spring slush' },
};

export const DEFAULT_TUNING = {
  mass: 78,                  // kg, rider plus kit
  gravity: 8.80,             // Deliberately under 9.81. Everything here is scaled by it -- the
                             // drive down the hill, the load on the board, the grip that load
                             // buys -- so lowering it does not break the balance, it just makes
                             // the whole thing a little less heavy and buys about 11% more hang
                             // time off every jump. Terminal speeds drop ~5% and stay in range.
  boardLength: 1.5,          // m, nose to tail
  boardWidth: 0.26,          // m, so an edged board touches on its edge, not its middle
  sidecutRadius: 8.0,        // m, a normal all-mountain board

  cdA: 0.62,                 // upright, which is what the terminal-speed figures are quoted for
  cdATuck: 0.30,             // and folded over the board, which should be worth having
  rho: 0.95,                 // air density on a MOUNTAIN. 1.2 is sea level, and a resort sits
                             // 2000 m up where the air is a fifth thinner -- which is a fifth
                             // less drag, and on a flat section drag is half of what stops you.

  contactEps: 0.05,          // m of clearance that still counts as touching...
  contactEpsGain: 0.008,     // ...which widens with speed, because a board doing 100 km/h is
  contactEpsMax: 0.20,       // planing across small gaps rather than leaving the snow at each one
  maxEdgeDeg: 65,            // past this the edge is not a usable angle any more
  edgeDeadzoneDeg: 2,

  slipPeakDeg: 5.5,          // slip angle where the edge is giving most of its grip
  muLatFlat: 0.08,           // a flat base still scrubs sideways, but far too little to hold a hill
  muLatMax: 1.20,            // hard ceiling: snow shears before an edge holds more than this
  muSkidExtra: 0.45,         // extra drag from a board ploughing sideways, as sin^2 of the slip
  ploughRef: 5.0,            // m/s that ploughing drag is quoted against; it grows as v^2 from there
  ploughMax: 4.0,            // and stops growing here, so a fast board is redirected, not deleted
  maxLoadG: 2.2,             // cap on how much a carve may load the board (expert carves peak near 2g)
  maxLatG: 2.6,                // and a hard ceiling on the lateral acceleration itself
  railHoldDeg: 6,            // slip angle up to which the board is still running in its own groove
  railGoneDeg: 24,           // and past which there is no groove left to follow
  holdTau: 0.05,             // s, how hard a standing edge resists creeping. NOT dt: that would
                             // make the model behave differently at different frame rates.
  bootMu: 0.55,              // boots on snow, for when you are standing rather than riding

  popEff: 0.72,              // how much of a foot-driven push into the snow reaches your centre
  popMax: 3.0,               // m/s, so ~0.46 m of air off a hard ollie
  popDead: 0.35,             // m/s of foot speed that is tracking noise, not intent
  flexTau: 0.14,             // s, how quickly the board takes up a bend
  flexPop: 1.5,              // m/s of rebound available from a fully loaded board

  bridge: 0.035,             // m, how much snow and board stiffness smooth out a sharp ridge
  bridgeGain: 0.007,         // ...and how much more of that a board planing at speed does
  bridgeMax: 0.18,
  bodyMin: 0.50,             // m, how close your head may get to the snow before your legs stop you.
                             // This has to be well under 0.75: the board sits at hand height, so
                             // riding normally already puts your head only ~0.75 m above the snow.
                             // That closeness is the point of the game, not a bug to raise away.
  noseDigScrub: 1.2,
  digThresholdRad: 0.40,     // ~23 deg of nose-down before the board really ploughs
};

const _a = new THREE.Vector3(), _c = new THREE.Vector3();
const _vb = new THREE.Vector3(), _vc = new THREE.Vector3(), _tan = new THREE.Vector3();
const _side = new THREE.Vector3(), _head = new THREE.Vector3();
const _nrm = [0, 1, 0];
const clamp = THREE.MathUtils.clamp, smooth = THREE.MathUtils.smoothstep;
const DEG = THREE.MathUtils.degToRad, RAD = THREE.MathUtils.radToDeg;

export class Rider {
  constructor(terrain, tuning = {}) {
    this.terrain = terrain;
    this.t = { ...DEFAULT_TUNING, ...tuning };
    this.snow = SNOW.groomed;

    this.pos = new THREE.Vector3();          // rig origin in world
    this.vel = new THREE.Vector3();
    this.yaw = 0;                            // never changes: the world does not turn you

    this.boardPos = new THREE.Vector3();
    this.boardNose = new THREE.Vector3(0, 0, 1);
    this.boardUp = new THREE.Vector3(0, 1, 0);
    this.boardVel = new THREE.Vector3();

    this.normal = new THREE.Vector3(0, 1, 0);
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(-1, 0, 0);

    this.grounded = false; this.standing = false; this.airTime = 0;
    this.speed = 0; this.slip = 0; this.edgeDeg = 0; this.pitchDeg = 0;
    this.lateralG = 0; this.carving = 0; this.skidding = 0;
    this.turnRadius = Infinity; this.railing = 0; this._popping = false;
    this.flex = 0; this.rebound = 0;
    this.noseGap = 0; this.tailGap = 0; this.contactGap = 0;
    this.lastEvent = null;
    this.time = 0;
  }

  // Put the board down at (x, z). The rig never rotates, so there is no heading to set.
  reset(x, z, _yaw = 0, pose = null) {
    this.yaw = 0;
    this.vel.set(0, 0, 0);
    const local = pose && pose.valid ? pose.center : _a.set(0, 0.85, 0);
    this.pos.set(x - local.x, this.terrain.heightAt(x, z) - local.y, z - local.z);
    this.grounded = true; this.standing = false; this.airTime = 0; this.lastEvent = null;
    this.speed = 0; this.slip = 0; this.carving = 0; this.skidding = 0; this.lateralG = 0;
    this._popping = false; this.railing = 0; this.flex = 0; this.rebound = 0;
  }

  // Rig space is world space (the rig never rotates), so the pose needs no transform.
  applyPose(pose) {
    if (pose && pose.valid) {
      this.boardPos.copy(this.pos).add(pose.center);
      this.boardNose.copy(pose.nose);
      this.boardUp.copy(pose.up);
    } else {
      this.boardPos.set(this.pos.x, this.pos.y + 0.85, this.pos.z);
      this.boardNose.set(0, 0, 1); this.boardUp.set(0, 1, 0);
    }
  }

  // `pose` is where your feet have put the board, `handVel` is how fast they are moving it, and
  // `head` is where your head is relative to the rig. Those three are the entire input.
  step(dt, pose, handVel = null, tuck = 0, head = null) {
    const t = this.t, T = this.terrain, v = this.vel, g = t.gravity;
    this.time += dt;
    this.lastEvent = null;

    this.applyPose(pose);
    const vb = _vb; if (handVel) vb.copy(handVel); else vb.set(0, 0, 0);
    this.boardVel.copy(vb);

    // gravity, once
    v.y -= g * dt;

    // air drag, always
    const spd0 = v.length();
    if (spd0 > 0.01) {
      const cdA = THREE.MathUtils.lerp(t.cdA, t.cdATuck, clamp(tuck, 0, 1));
      v.addScaledVector(v, -((cdA * t.rho * spd0) / (2 * t.mass)) * dt);
    }

    const c = this.sampleContact();
    this.noseGap = c.noseGap; this.tailGap = c.tailGap; this.contactGap = c.gap;
    const wasGrounded = this.grounded;
    const eps = this.contactEps();
    // `touching` decides whether the snow acts on you this step. `this.grounded` is what the
    // HUD, audio and spray read, and it is owned by resolveContact/constrainBody at the end of
    // the step so it can never disagree with the forces that were actually applied.
    const touching = c.gap <= eps;

    if (touching) this.contactForces(dt, c, vb);
    else {
      this.airTime += dt;
      this.carving = 0; this.skidding = 0; this.lateralG = 0; this.railing = 0;
      this.flex = 0; this.rebound = 0;
      this.turnRadius = Infinity; this.edgeDeg = 0; this.pitchDeg = 0;
    }

    this.pos.addScaledVector(v, dt);
    this.resolveContact(pose, wasGrounded, vb);
    this.constrainBody(dt, head, pose);
    this.speed = v.length();
  }

  // Everything the snow does to you, in one place.
  contactForces(dt, c, vb) {
    const t = this.t, T = this.terrain, v = this.vel, g = t.gravity;

    // Average the snow's normal along the board rather than reading it off one point. A single
    // sample steps every time the contact crosses a grid line, and every force in this function
    // is built on that vector, so the step goes into all of them at once.
    const reach = Math.min(t.boardLength * 0.5, 0.4 + this.speed * 0.03);
    const n = this.normal.set(0, 0, 0);
    for (const along of [-reach, 0, reach]) {
      const nArr = T.normalAt(c.x + this.boardNose.x * along, c.z + this.boardNose.z * along, _nrm);
      n.x += nArr[0]; n.y += nArr[1]; n.z += nArr[2];
    }
    n.normalize();

    // board frame, projected onto the snow
    const f = this.forward.copy(this.boardNose);
    f.addScaledVector(n, -f.dot(n));
    if (f.lengthSq() < 1e-6) f.crossVectors(n, this.boardUp);        // board stood on end
    f.normalize();
    const r = this.right.crossVectors(f, n).normalize();
    const bUp = this.boardUp;

    // Edge angle: how far the deck is rolled away from the snow about the board's own axis.
    // psi > 0 means the deck has tipped toward +r, which puts the +r edge into the snow.
    const maxPsi = DEG(t.maxEdgeDeg);
    const upDot = bUp.dot(n);
    const psi = clamp(Math.atan2(bUp.dot(r), Math.max(1e-4, upDot)), -maxPsi, maxPsi);
    const pitch = Math.atan2(bUp.dot(f), Math.max(1e-4, upDot));
    const mag = Math.abs(psi);
    // A board rolled past its side has no edge in the snow at all. Without this it reads as a
    // clamped 65 degrees -- maximum grip -- purely because the arctangent wrapped round.
    const upright = smooth(upDot, 0.0, 0.30);
    this.edgeDeg = RAD(psi); this.pitchDeg = RAD(pitch);

    // THE contact patch velocity: rider plus feet. This one line is why shoving a gripping
    // edge moves you, and why it needs no special case anywhere.
    const vc = _vc.copy(v).add(vb);
    const vT3 = _tan.copy(vc).addScaledVector(n, -vc.dot(n));
    const vf = vT3.dot(f), vr = vT3.dot(r);
    const vT = Math.hypot(vf, vr);
    // Riding switch flips which way the arc goes. Blended rather than a hard sign, because a
    // hard one chatters every time the forward component crosses zero in a sideslip.
    const sw = Math.tanh(vf / 0.6);
    const beta = Math.atan2(vr, Math.max(Math.abs(vf), 0.05));
    this.slip = beta;

    const dead = DEG(t.edgeDeadzoneDeg);
    const engage = smooth(mag, dead, dead + 0.22) * upright;
    const cosA = Math.max(0.2, n.y);

    // Normal load. A carve presses the board into the snow well past body weight, and that
    // extra load is exactly why a committed turn grips harder than a timid one.
    const loadA = Math.min(Math.hypot(g * cosA, this.lateralG * g), t.maxLoadG * g);

    // Weight forward sharpens the edge; sitting back washes the nose out.
    const press = clamp((this.tailGap - this.noseGap) / 0.35, -1, 1);
    const bias = (1 - 0.30 * Math.max(0, -press)) * (1 + 0.12 * Math.max(0, press));

    // Available edge grip. tan(psi) is the classic edge relation; the flat term is there
    // because a base is never truly clear of the snow.
    const muLat = Math.min(t.muLatFlat + Math.tan(Math.min(mag, 1.3)) * engage * this.snow.grip * bias, t.muLatMax);

    const Fmax = muLat * loadA;                                       // as an acceleration

    // ---- THE CARVE ----
    // Turning happens exactly one way. You swing the board; that opens a slip angle between where
    // the board points and where you are actually going; the edge grips that slip angle and drags
    // your velocity round to follow it. Nothing else steers, and there is no steering input to
    // find anywhere in this file. A flat board opens the very same slip angle and has almost no
    // grip to convert it, which is why it skids instead of turning.
    //
    // A board tilted to psi is bent into an arc of R = Rsc*cos(psi), and the tip of that bent
    // edge already meets the snow slightly off the centre line. That is a real angle of attack,
    // so a tilted board begins to come round before you swing it at all -- but only a little.
    // A board you refuse to rotate runs very nearly straight, which is what one does in life.
    //
    // An earlier version also carried an explicit groove constraint here: measure how fast the
    // board is being swung, and drive the path round at that rate, clipped to the sidecut. Fifty
    // lines, and ablating it changed a two-second carve by ONE degree while making it cost more
    // speed. The slip-angle curve below was doing all of the work the whole time. It is gone.
    const R = Math.max(1.0, t.sidecutRadius * Math.cos(Math.min(mag, 1.3)));
    const rail = engage * (1 - smooth(Math.abs(beta), DEG(t.railHoldDeg), DEG(t.railGoneDeg)));
    const swSign = vf < 0 ? -1 : 1;                                   // riding switch flips the arc
    const swFade = Math.tanh(Math.abs(vf) / 0.6);                     // ...and there is no arc at rest
    const edgeDir = Math.sign(psi || 1) * swSign;                     // the way THIS edge can push
    const betaSc = edgeDir * rail * swFade * Math.asin(Math.min(0.5, (t.boardLength * 0.5) / R)) * 0.6;
    this.railing = rail;

    // Grip builds with slip angle on the saturating curve a tyre has, and a railed edge bites at
    // a far smaller angle than a sliding one -- that is what being railed means. Leave the curve
    // as soft as a skidding board's and a clean carve settles at 9 degrees of slip and ploughs
    // its own speed away.
    const hold = 1 - smooth(vT, 0.4, 1.6);                            // below walking pace slip angle is meaningless
    const peak = DEG(t.slipPeakDeg) * (1 - 0.6 * rail);
    let aLat = -Fmax * Math.tanh((beta - betaSc) / peak) * (1 - hold);
    // ...and below walking pace the edge simply resists being pushed sideways, up to the same
    // limit. On a fixed time constant, so the model does not change with the frame rate.
    if (hold > 0) aLat += clamp(-vr / t.holdTau, -Fmax * hold, Fmax * hold);
    aLat = clamp(aLat, -t.maxLatG * g, t.maxLatG * g);

    // ---- everything that costs you speed ----
    // All of it acts against the direction of TRAVEL. Charging it along the board's own axis
    // instead means a board sliding dead sideways, where the forward component is ~0, is charged
    // almost nothing: that let a flat base sideslip at 70 km/h and made pointing FURTHER across
    // the hill go FASTER than pointing down it.
    const dig = Math.max(0, Math.abs(pitch) - t.digThresholdRad) * t.noseDigScrub;
    const mu = this.snow.mu + dig * 0.20;
    v.addScaledVector(r, aLat * dt);                                  // the edge force itself
    if (vT > 1e-3) {
      const ux = vf / vT, uz = vr / vT;                               // unit travel, in board axes

      // A board ploughing at an angle throws snow. It scales with SPEED, because displacing snow
      // is something you do by moving -- a drag proportional to load alone is a brake that still
      // works at a standstill, which used to pin the rider at exactly zero. And it scales with
      // EDGE, because ploughing is an edge cutting a furrow rather than a base sliding over it.
      const sb = Math.sin(beta);
      // Quadratic in speed, because displacing snow moves mass at a rate proportional to how
      // fast you are going, so the force goes as v^2. A drag that saturates instead has no speed
      // limit of its own: it left a flat base sideslipping at 55 km/h on a 22 deg pitch while
      // still being too grippy to get moving at all on a gentle one.
      const ramp = Math.min(t.ploughMax, (vT / t.ploughRef) ** 2);
      // Almost all of the ploughing is the EDGE. A flat base pushed sideways slides over the
      // top of the snow and keeps most of its speed -- that is a drift, and it should feel like
      // one. An edge at the same angle cuts a furrow and stops you. Charging both the same made
      // every board angle past about 50 degrees a brake instead of a change of direction.
      // Ploughing is the EDGE, and it has to scale with HOW MUCH edge. Scaling it by `engage`
      // was wrong: that is a smoothstep already saturated by about 15 degrees, so a board tilted
      // a few degrees ploughed exactly like one on a full edge. That is what made swinging the
      // board across kill your speed without turning you much -- hands naturally hold the board
      // near level, and level across a slope is only a small edge. Furrow depth goes with the
      // sine of the edge angle, so that is what this scales with, reaching full bite at 45 deg.
      const bite = 0.16 + 0.84 * Math.min(1, Math.sin(mag) / 0.7071);
      const aPlough = t.muSkidExtra * loadA * sb * sb * ramp * bite;

      // The edge force acts ACROSS the board, and the board is at a slip angle, so that force has
      // a component along your direction of travel. A blade cutting snow can only ever take
      // energy out, so that component is induced drag and never thrust. Without this the model
      // is a free-energy source: on flat ground, swinging the board back and forth accelerated
      // you from 36 to 41 km/h, and windmilling your arms beat riding.
      const along = aLat * uz;
      const aDrag = Math.min(mu * loadA + aPlough + Math.abs(along), vT / dt);
      v.addScaledVector(f, (-along - aDrag) * ux * dt);
      v.addScaledVector(r, (-along - aDrag) * uz * dt);
    }

    // readouts
    // What you actually feel is the acceleration perpendicular to where you are GOING, not
    // across the board. At a slip angle those differ, and the board-frame number overstates it.
    this.lateralG = (aLat * Math.cos(beta)) / g;
    const speed = Math.hypot(v.dot(f), v.dot(r));
    this.turnRadius = Math.abs(aLat) > 1e-3 ? (speed * speed) / Math.abs(aLat) : Infinity;
    // Board flex. A loaded board takes up a bend and gives that energy back when you let the
    // edge go -- it is what riders mean by a board coming alive, and it is why you can leave a
    // carve into the air without ever ollieing. Charge on load above body weight, release when
    // the load drops faster than the board can relax.
    // Charging is filtered, because a board takes a moment to bend. RELEASE is instant and
    // spent here, in contact, where there is still something to push off. Routing it through the
    // jump constraint instead never fired: flattening an edge lifts the contact point ~9 cm,
    // which puts the board out of contact in the very step the release happens.
    const over = clamp((loadA - g * cosA) / (t.maxLoadG * g - g * cosA), 0, 1);
    if (over < this.flex) {
      this.rebound = Math.min((this.flex - over) * t.flexPop, t.flexPop);
      v.addScaledVector(n, this.rebound);
      this.flex = over;                          // spent, so it cannot be released twice
    } else {
      this.rebound = 0;
      this.flex += (over - this.flex) * Math.min(1, dt / t.flexTau);
    }

    this.carving = rail * Math.min(1, speed / 3);
    this.skidding = Math.min(1, Math.abs(vr) / 3) * (1 - rail * 0.7);
  }

  // How far off the snow still counts as being on it. At 28 m/s a board covers 23 cm in a single
  // physics step, and the heightfield has a slope crease every 2 m, so a fixed 5 cm band had the
  // rider registering as airborne 51% of the time above 95 km/h and taking off nearly four times
  // a second. That is the jitter: not noise in the terrain, but skipping off it.
  contactEps() {
    return this.t.contactEps + Math.min(this.t.contactEpsMax, this.speed * this.t.contactEpsGain);
  }

  // Lowest point of the board against the snow, sampled along its length AND across its width,
  // because a board rolled onto an edge touches on that edge, not down its centre line.
  sampleContact() {
    const t = this.t, T = this.terrain;
    // A board planes. At 30 m/s it skims the tops of anything small, and the heightfield is
    // bilinear on a 2 m grid, so it has a slope crease at every cell edge that a rigid contact
    // turns into a step straight into the rider's head -- measured at up to 900 m/s2 of vertical
    // acceleration above 95 km/h, which is exactly the jitter you feel at speed. Widening the
    // soft minimum with speed is what a planing board physically does.
    const bridge = t.bridge + Math.min(t.bridgeMax, this.speed * t.bridgeGain);
    const half = t.boardLength * 0.5, halfW = t.boardWidth * 0.5;
    _side.crossVectors(this.boardUp, this.boardNose).normalize();
    let gap = Infinity, gx = this.boardPos.x, gz = this.boardPos.z;
    let noseGap = Infinity, tailGap = Infinity;
    let soft = 0;                                    // running sum for the soft minimum below
    for (const along of [half, 0, -half]) {
      for (const across of [-halfW, 0, halfW]) {
        const px = this.boardPos.x + this.boardNose.x * along + _side.x * across;
        const py = this.boardPos.y + this.boardNose.y * along + _side.y * across;
        const pz = this.boardPos.z + this.boardNose.z * along + _side.z * across;
        const gp = py - T.heightAt(px, pz);
        if (gp < gap) { gap = gp; gx = px; gz = pz; }
        soft += Math.exp(-gp / bridge);
        if (along > 0 && gp < noseGap) noseGap = gp;
        if (along < 0 && gp < tailGap) tailGap = gp;
      }
    }
    // A SOFT minimum, not a hard one. The heightfield is bilinear on a 2 m grid, so it has a
    // crease at every grid line, and a board resting on whichever single sample happens to be
    // highest steps over each of those -- measured at up to 1000 m/s2 straight into the player's
    // head. A real board is stiff and bridges small irregularities, and snow compresses under the
    // point that is bearing. This rounds the corner over roughly 3.5 cm and does nothing else:
    // on smooth ground every sample agrees and it returns the same answer as the hard minimum.
    return { gap: -bridge * Math.log(soft / 9), x: gx, z: gz, noseGap, tailGap };
  }

  // The board may not go under the snow. Satisfying that is the whole of jumping: drive the
  // board down with your feet, the snow will not move, so you go up instead.
  resolveContact(pose, wasGrounded, vb) {
    const t = this.t, T = this.terrain, v = this.vel;
    this.applyPose(pose);
    const c = this.sampleContact();
    this.contactGap = c.gap; this.noseGap = c.noseGap; this.tailGap = c.tailGap;
    if (c.gap > this.contactEps()) { this.grounded = false; return; }

    // Resolve PENETRATION only. Snapping the board back down onto the snow when it is already
    // clear of it would cancel every ollie the moment it started -- the rider would rise, get
    // pulled straight back to the surface, and never leave the ground.
    if (c.gap < 0) { this.pos.y -= c.gap; this.boardPos.y -= c.gap; }
    const nArr = T.normalAt(c.x, c.z);
    const n = _c.set(nArr[0], nArr[1], nArr[2]).normalize();

    // One velocity-level constraint does landing AND jumping, because they are the same thing.
    // The board's contact point may not move into the snow, so v_rider.n must be at least as
    // positive as the board is being driven down. Landing: the board is still, the target is
    // zero, and your downward speed is taken by the snow. Ollie: your legs drive the board
    // down, the snow will not move, so your centre goes up instead. It is a CONSTRAINT, not a
    // repeated shove, so holding a crouch does not keep adding speed.
    const vn = v.dot(n);
    const drive = Math.max(0, -vb.dot(n) - t.popDead);
    const target = Math.min(drive * t.popEff, t.popMax);
    if (vn < target) {
      v.addScaledVector(n, target - vn);
      if (target > 0.45 && !this._popping) { this.lastEvent = { type: 'pop', v: target }; this._popping = true; }
    }
    if (target <= 0.2) this._popping = false;

    if (!wasGrounded) {
      if (this.airTime > 0.12) this.lastEvent = { type: 'land', impact: Math.max(0, -vn), air: this.airTime };
      this.airTime = 0;
    }
    this.grounded = true;
  }

  // You have a body. Holding the board over your head must lift the board off the snow rather
  // than bury you in it, so your head may not get closer to the snow than a deep crouch.
  //
  // When that happens you are STANDING, not riding, and standing has to cost what standing
  // costs. Killing the downward velocity outright, as the first version did, also killed every
  // bit of downhill drive, which turned holding the board up into a frictionless glide that
  // carried you further than riding did.
  constrainBody(dt, head, pose) {
    this.standing = false;
    if (!head) return;
    _head.copy(this.pos).add(head);
    const floor = this.terrain.heightAt(_head.x, _head.z) + this.t.bodyMin;
    if (_head.y >= floor) return;

    this.pos.y += floor - _head.y;
    const nArr = this.terrain.normalAt(_head.x, _head.z);
    const n = _c.set(nArr[0], nArr[1], nArr[2]).normalize();
    const v = this.vel;
    const vn = v.dot(n);
    if (vn < 0) v.addScaledVector(n, -vn);            // only the INTO-the-slope part, so gravity still pulls

    // Boots on snow, which grip far harder than a base does. You can stand on a hill like this,
    // and shuffle down it, but you are not riding anywhere.
    _tan.copy(v).addScaledVector(n, -v.dot(n));
    const sp = _tan.length();
    if (sp > 1e-4) {
      const a = Math.min(this.t.bootMu * this.t.gravity * Math.max(0.2, n.y), sp / dt);
      v.addScaledVector(_tan, -a * dt / sp);
    }
    this.standing = true;
    this.grounded = false;            // the board is clear of the snow; your legs are holding you up
    this.airTime = 0;                 // ...and standing on your feet is not air time
    this.applyPose(pose);
  }
}
