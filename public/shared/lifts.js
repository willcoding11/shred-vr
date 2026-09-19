// Chairlifts: towers, cable, chairs, and a line you can actually ride.
//
// A lift is stored as nothing more than two points -- where it starts and where it ends. Towers,
// spans, sag and chair spacing are all derived from the terrain between them, so a lift can be
// dropped anywhere on a map by an editor or a generator without anyone having to place hardware.
//
// The cable hangs from tower tops and sags between them, and the chairs hang under the cable.
// Riding one means your rig follows a chair, which is why `seatAt` exists separately: it is the
// one number the game needs, and it has to be the same one the chair mesh is drawn at.
import * as THREE from 'three';
import { heightAt } from './mapformat.js';

export const LIFT = {
  towerH: 8.5,        // m, mast height above the snow
  span: 58,           // m between towers, before rounding to fit the line
  sag: 1.9,           // m the cable drops at mid-span
  gauge: 2.3,         // m between the up cable and the down cable
  hanger: 2.5,        // m from cable to seat
  chairGap: 34,       // m between chairs
  speed: 5.0,         // m/s, a detachable quad. A fixed-grip double is half that and the ride
                      // up a 900 m line then takes five and a half minutes, which is a long
                      // time to sit in a headset even with a skip button.
  boardRadius: 9,     // m around the base station where a chair will pick you up
  towerMax: 24,       // m, how tall a pylon may grow to clear the ground under its span
};

// Everything derived from the two end points. Call once per map load.
export function buildLine(map, lift) {
  const dx = lift.top.x - lift.base.x, dz = lift.top.z - lift.base.z;
  const len = Math.hypot(dx, dz) || 1;
  const n = Math.max(2, Math.round(len / LIFT.span));
  const towers = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = lift.base.x + dx * t, z = lift.base.z + dz * t;
    const ground = heightAt(map, x, z);
    // The end towers are shorter: a station is a low structure you step off, not a pylon.
    const h = i === 0 || i === n ? LIFT.towerH * 0.62 : LIFT.towerH;
    towers.push({ x, z, ground, top: ground + h, h });
  }
  const line = {
    id: lift.id, name: lift.name || 'Lift', lift, len, n, towers,
    dir: { x: dx / len, z: dz / len },
    side: { x: -dz / len, z: dx / len },       // across the line, for the two cables
    rideTime: len / LIFT.speed,
  };

  // Grow the towers until the cable clears the ground the whole way. A straight span between two
  // tower tops cuts straight through any bulge between them, and on real terrain there is always
  // a bulge: without this a lift dropped on a new map hangs its chairs through the hillside, and
  // the only way to find out is to ride it. Six passes is enough for anything sane.
  const need = LIFT.hanger + 2.0;
  const probe = new THREE.Vector3();
  for (let pass = 0; pass < 6; pass++) {
    let worst = 0, at = 0;
    for (let k = 0; k <= n * 12; k++) {
      const t = k / (n * 12);
      cableAt(line, t, 0, probe);
      const deficit = need - (probe.y - heightAt(map, probe.x, probe.z));
      if (deficit > worst) { worst = deficit; at = t; }
    }
    if (worst <= 0.02) break;
    const i = Math.min(n - 1, Math.floor(at * n));
    for (const k of [i, i + 1]) {
      const add = Math.min(worst, LIFT.towerMax - towers[k].h);
      towers[k].h += add; towers[k].top += add;
    }
  }
  return line;
}

// A point on the cable. `t` runs 0 at the base to 1 at the top; `side` is -1 or +1 for the two
// cables, or 0 for the centre line.
export function cableAt(line, t, side = 0, out = new THREE.Vector3()) {
  const u = Math.min(1, Math.max(0, t)) * line.n;
  const i = Math.min(line.n - 1, Math.floor(u)), f = u - i;
  const a = line.towers[i], b = line.towers[i + 1];
  const sag = Math.sin(f * Math.PI) * LIFT.sag;
  const half = (LIFT.gauge / 2) * side;
  return out.set(
    a.x + (b.x - a.x) * f + line.side.x * half,
    a.top + (b.top - a.top) * f - sag,
    a.z + (b.z - a.z) * f + line.side.z * half,
  );
}

// Where a rider sitting on the up-going chair at `t` actually is. The game reads this; the chair
// mesh is drawn from the same call, so the two can never drift apart.
export function seatAt(line, t, out = new THREE.Vector3()) {
  cableAt(line, t, 1, out);
  out.y -= LIFT.hanger;
  return out;
}

// Where you step off at the top. NOT along the line: a lift runs uphill, so carrying on in its
// direction walks you straight into whatever the top station is built against -- on this map, 16 m
// up the summit ridge. You get off on the DOWNHILL side, a little to one side of the cable.
export function unloadSpot(line, terrain, out = { x: 0, z: 0 }) {
  const top = line.towers[line.n];
  const gx = terrain.heightAt(top.x + 6, top.z) - terrain.heightAt(top.x - 6, top.z);
  const gz = terrain.heightAt(top.x, top.z + 6) - terrain.heightAt(top.x, top.z - 6);
  const d = Math.hypot(gx, gz) || 1;
  out.x = top.x - (gx / d) * 18 + line.side.x * 7;
  out.z = top.z - (gz / d) * 18 + line.side.z * 7;
  return out;
}

// The base station nearest to a point, if you are close enough to be picked up.
export function baseNear(lines, x, z, radius = LIFT.boardRadius) {
  let best = null, bestD = radius * radius;
  for (const line of lines) {
    const b = line.towers[0];
    const d = (b.x - x) ** 2 + (b.z - z) ** 2;
    if (d < bestD) { bestD = d; best = line; }
  }
  return best;
}

// ---------------------------------------------------------------- rendering
const MAT = {
  steel: new THREE.MeshStandardMaterial({ color: 0x5b6472, roughness: 0.55, metalness: 0.5 }),
  cable: new THREE.MeshStandardMaterial({ color: 0x2b323c, roughness: 0.6, metalness: 0.4 }),
  chair: new THREE.MeshStandardMaterial({ color: 0xd2453c, roughness: 0.6, metalness: 0.1 }),
  seat: new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.8 }),
  house: new THREE.MeshStandardMaterial({ color: 0x8d99a8, roughness: 0.8 }),
};

function tower(line, i, shadows) {
  const t = line.towers[i], g = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.46, t.h, 8), MAT.steel);
  mast.position.y = t.h / 2; mast.castShadow = shadows; g.add(mast);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(LIFT.gauge + 1.4, 0.26, 0.4), MAT.steel);
  arm.position.y = t.h; arm.castShadow = shadows;
  arm.rotation.y = Math.atan2(line.side.x, line.side.z) + Math.PI / 2;
  g.add(arm);
  for (const s of [-1, 1]) {
    const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.2, 10), MAT.cable);
    sheave.rotation.z = Math.PI / 2;
    sheave.position.set(line.side.x * (LIFT.gauge / 2) * s, t.h - 0.2, line.side.z * (LIFT.gauge / 2) * s);
    sheave.rotation.y = Math.atan2(line.dir.x, line.dir.z);
    g.add(sheave);
  }
  g.position.set(t.x, t.ground, t.z);
  return g;
}

function chairMesh(shadows) {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, LIFT.hanger, 6), MAT.steel);
  bar.position.y = -LIFT.hanger / 2; g.add(bar);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 0.62), MAT.seat);
  seat.position.y = -LIFT.hanger; seat.castShadow = shadows; g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.72, 0.1), MAT.chair);
  back.position.set(0, -LIFT.hanger + 0.42, -0.3); back.castShadow = shadows; g.add(back);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.36, 0.62), MAT.chair);
    arm.position.set(s * 0.82, -LIFT.hanger + 0.22, 0); g.add(arm);
  }
  const foot = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.3), MAT.steel);
  foot.position.set(0, -LIFT.hanger - 0.52, 0.42); g.add(foot);
  return g;
}

function station(line, end, shadows) {
  const t = line.towers[end ? line.n : 0], g = new THREE.Group();
  const roof = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.4, 5.5), MAT.house);
  roof.position.y = t.h + 0.6; roof.castShadow = shadows; g.add(roof);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, t.h + 0.6, 0.3), MAT.steel);
    post.position.set(sx * 3.3, (t.h + 0.6) / 2, sz * 2.4); g.add(post);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.18, 7), MAT.house);
  deck.position.y = 0.09; deck.receiveShadow = shadows; g.add(deck);
  g.position.set(t.x, t.ground, t.z);
  g.rotation.y = Math.atan2(line.dir.x, line.dir.z);
  return g;
}

export class LiftRenderer {
  constructor(map, { shadows = true } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'lifts';
    this.lines = (map.lifts || []).map((l) => buildLine(map, l));
    this.chairs = [];
    this.phase = 0;
    for (const line of this.lines) {
      for (let i = 0; i <= line.n; i++) this.group.add(tower(line, i, shadows));
      this.group.add(station(line, false, shadows), station(line, true, shadows));
      // the cable itself, as a thin tube through the sagging spans
      for (const side of [-1, 1]) {
        const pts = [];
        for (let k = 0; k <= line.n * 6; k++) pts.push(cableAt(line, k / (line.n * 6), side));
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), line.n * 6, 0.05, 5, false), MAT.cable);
        this.group.add(tube);
      }
      // chairs, evenly spaced, going up one side and back down the other
      const count = Math.max(2, Math.round(line.len / LIFT.chairGap));
      for (let i = 0; i < count; i++) {
        for (const side of [1, -1]) {
          const m = chairMesh(shadows);
          this.chairs.push({ mesh: m, line, side, offset: i / count });
          this.group.add(m);
        }
      }
    }
    this._v = new THREE.Vector3();
  }

  update(dt) {
    if (!this.lines.length) return;
    this.phase += dt;
    for (const c of this.chairs) {
      const travel = this.phase / c.line.rideTime;
      let t = (c.offset + travel) % 1;
      if (c.side < 0) t = 1 - t;                       // the down side runs the other way
      cableAt(c.line, t, c.side, this._v);
      c.mesh.position.copy(this._v);
      c.mesh.rotation.y = Math.atan2(c.line.dir.x, c.line.dir.z) + (c.side < 0 ? Math.PI : 0);
    }
  }

  // Where the chair a rider boarded at time `phase0` has got to, as a 0..1 parameter.
  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
}
