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
import { mergeGeometries as _mergeLift } from 'three/addons/utils/BufferGeometryUtils.js';
const mergeLift = (parts) => _mergeLift(parts.map((g) => (g.index ? g.toNonIndexed() : g)));

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
// envMapIntensity matters here more than anywhere else in the scene. The lift is the only man-made
// thing in frame and the eye goes straight to it, and with scene.environmentIntensity at 0.55 the
// image-based lighting we build a PMREM for was barely reaching the only metal in the world: a
// galvanised mast and a steel cable were both rendering as flat grey plastic. A cable also wants
// to be SMOOTH -- at roughness 0.6 it never caught a highlight along its length, and that highlight
// is the one thing that tells you it is a cable rather than a line someone drew.
const MAT = {
  steel: new THREE.MeshStandardMaterial({ color: 0x5b6472, roughness: 0.42, metalness: 0.75, envMapIntensity: 2.0 }),
  cable: new THREE.MeshStandardMaterial({ color: 0x2b323c, roughness: 0.25, metalness: 0.85, envMapIntensity: 2.2 }),
  chair: new THREE.MeshStandardMaterial({ color: 0xd2453c, roughness: 0.6, metalness: 0.1 }),
  seat: new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.8 }),
  house: new THREE.MeshStandardMaterial({ color: 0x8d99a8, roughness: 0.8 }),
};

// Returns { steel, dark } geometry already placed in world space. It used to return a Group of
// four or five separate meshes per tower, and with the chairs on top of it one lift was putting
// three hundred and forty objects into the scene -- 681 for the two on Alpine Bowl. On a headset
// the draw call is the expensive part, not the triangle.
function towerGeo(line, i) {
  const t = line.towers[i], g = { steel: [], dark: [] };
  // A LATTICE, not a lamppost. One tapered cylinder with a box across the top was the most
  // game-looking object on the mountain. Three splayed legs and a ladder of cross bracing is
  // about forty triangles, merged into one geometry, and it reads as lift hardware immediately.
  const parts = [];
  const RT = 0.26, RB = 0.62, ang = (k) => (k / 3) * Math.PI * 2 + 0.3;
  for (let k = 0; k < 3; k++) {
    const a = ang(k);
    const leg = new THREE.CylinderGeometry(0.075, 0.105, t.h, 5).translate(0, t.h / 2, 0);
    const p = leg.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i), f = RT + (RB - RT) * (1 - y / t.h);
      p.setXYZ(i, p.getX(i) + Math.cos(a) * f, y, p.getZ(i) + Math.sin(a) * f);
    }
    leg.computeVertexNormals();
    parts.push(leg);
  }
  const bands = Math.max(2, Math.round(t.h / 2.6));
  for (let b = 1; b <= bands; b++) {
    const y = (b / (bands + 1)) * t.h, f = RT + (RB - RT) * (1 - y / t.h);
    for (let k = 0; k < 3; k++) {
      const a0 = ang(k), a1 = ang(k + 1);
      const x0 = Math.cos(a0) * f, z0 = Math.sin(a0) * f, x1 = Math.cos(a1) * f, z1 = Math.sin(a1) * f;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const bar = new THREE.CylinderGeometry(0.045, 0.045, len, 4);
      bar.rotateZ(Math.PI / 2); bar.rotateY(-Math.atan2(z1 - z0, x1 - x0));
      bar.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
      parts.push(bar);
    }
  }
  parts.push(new THREE.CylinderGeometry(RB + 0.3, RB + 0.34, 0.3, 12).translate(0, 0.15, 0));  // base plate
  g.steel.push(mergeLift(parts));
  const arm = new THREE.BoxGeometry(LIFT.gauge + 1.4, 0.26, 0.4);
  arm.rotateY(Math.atan2(line.side.x, line.side.z) + Math.PI / 2);
  arm.translate(0, t.h, 0);
  g.steel.push(arm);
  for (const sg of [-1, 1]) {
    const sheave = new THREE.CylinderGeometry(0.42, 0.42, 0.2, 10);
    sheave.rotateZ(Math.PI / 2);
    sheave.rotateY(Math.atan2(line.dir.x, line.dir.z));
    sheave.translate(line.side.x * (LIFT.gauge / 2) * sg, t.h - 0.2, line.side.z * (LIFT.gauge / 2) * sg);
    g.dark.push(sheave);
  }
  for (const list of [g.steel, g.dark]) for (const geo of list) geo.translate(t.x, t.ground, t.z);
  return g;
}

// Two geometries rather than six meshes, split by material so one InstancedMesh can carry every
// chair on every lift for each: two draw calls for all of them, instead of one Group of six per
// chair and two hundred chairs.
function chairGeos() {
  const steel = [
    new THREE.CylinderGeometry(0.06, 0.06, LIFT.hanger, 6).translate(0, -LIFT.hanger / 2, 0),
    new THREE.BoxGeometry(1.5, 0.08, 0.3).translate(0, -LIFT.hanger - 0.52, 0.42),
    new THREE.BoxGeometry(0.34, 0.20, 0.34).translate(0, -0.1, 0),          // the grip clamp
  ];
  const body = [
    new THREE.BoxGeometry(1.7, 0.12, 0.62).translate(0, -LIFT.hanger, 0),
    new THREE.BoxGeometry(1.7, 0.72, 0.1).translate(0, -LIFT.hanger + 0.42, -0.3),
    new THREE.BoxGeometry(0.08, 0.36, 0.62).translate(-0.82, -LIFT.hanger + 0.22, 0),
    new THREE.BoxGeometry(0.08, 0.36, 0.62).translate(0.82, -LIFT.hanger + 0.22, 0),
  ];
  return { steel: mergeLift(steel), body: mergeLift(body) };
}

function stationGeo(line, end) {
  const t = line.towers[end ? line.n : 0];
  const house = [
    new THREE.BoxGeometry(7.5, 0.4, 5.5).translate(0, t.h + 0.6, 0),
    new THREE.BoxGeometry(8.5, 0.18, 7).translate(0, 0.09, 0),
  ];
  const steel = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    steel.push(new THREE.BoxGeometry(0.3, t.h + 0.6, 0.3).translate(sx * 3.3, (t.h + 0.6) / 2, sz * 2.4));
  }
  const yaw = Math.atan2(line.dir.x, line.dir.z);
  for (const list of [house, steel]) for (const geo of list) { geo.rotateY(yaw); geo.translate(t.x, t.ground, t.z); }
  return { house, steel };
}

export class LiftRenderer {
  constructor(map, { shadows = true } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'lifts';
    this.lines = (map.lifts || []).map((l) => buildLine(map, l));
    this.chairs = [];
    this.phase = 0;
    const steel = [], dark = [], house = [];
    for (const line of this.lines) {
      for (let i = 0; i <= line.n; i++) {
        const g = towerGeo(line, i);
        steel.push(...g.steel); dark.push(...g.dark);
      }
      for (const end of [false, true]) {
        const g = stationGeo(line, end);
        house.push(...g.house); steel.push(...g.steel);
      }
      // the cable itself, as a thin tube through the sagging spans
      for (const side of [-1, 1]) {
        const pts = [];
        for (let k = 0; k <= line.n * 6; k++) pts.push(cableAt(line, k / (line.n * 6), side));
        // 3 radial segments, not 5. It is a five-centimetre cable; nobody has ever counted its
        // sides, and at 5 it was costing more triangles than the towers it hangs from.
        dark.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), line.n * 4, 0.05, 3, false));
      }
      // chairs, evenly spaced, going up one side and back down the other
      const count = Math.max(2, Math.round(line.len / LIFT.chairGap));
      for (let i = 0; i < count; i++) for (const side of [1, -1]) {
        this.chairs.push({ line, side, offset: i / count });
      }
    }
    const add = (parts, mat, name, cast) => {
      if (!parts.length) return;
      const m = new THREE.Mesh(mergeLift(parts), mat);
      m.castShadow = shadows && cast; m.receiveShadow = shadows; m.name = name;
      this.group.add(m);
    };
    add(steel, MAT.steel, 'lift-steel', true);
    add(dark, MAT.cable, 'lift-cable', false);
    add(house, MAT.house, 'lift-house', true);

    if (this.chairs.length) {
      const g = chairGeos();
      this.chairSteel = new THREE.InstancedMesh(g.steel, MAT.steel, this.chairs.length);
      this.chairBody = new THREE.InstancedMesh(g.body, MAT.chair, this.chairs.length);
      for (const m of [this.chairSteel, this.chairBody]) {
        m.castShadow = shadows; m.frustumCulled = false; m.name = 'lift-chairs';
        m.count = 0;          // nothing until update() has put them on the cable
        this.group.add(m);
      }
    }
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  update(dt, viewerPos) {
    if (!this.lines.length || !this.chairSteel) return;
    this.phase += dt;
    // Only the chairs near enough to make out. A lift line is two hundred chairs and you can read
    // maybe a dozen of them; the rest are a row of dots that cost a full chair each.
    const far = 340 * 340;
    let n = 0;
    for (let i = 0; i < this.chairs.length; i++) {
      const c = this.chairs[i];
      const travel = this.phase / c.line.rideTime;
      let t = (c.offset + travel) % 1;
      if (c.side < 0) t = 1 - t;                       // the down side runs the other way
      cableAt(c.line, t, c.side, this._v);
      this._e.set(0, Math.atan2(c.line.dir.x, c.line.dir.z) + (c.side < 0 ? Math.PI : 0), 0);
      this._q.setFromEuler(this._e);
      if (viewerPos) {
        const dx = this._v.x - viewerPos.x, dz = this._v.z - viewerPos.z;
        if (dx * dx + dz * dz > far) continue;
      }
      this._m.compose(this._v, this._q, this._s);
      this.chairSteel.setMatrixAt(n, this._m);
      this.chairBody.setMatrixAt(n, this._m);
      n++;
    }
    this.chairSteel.count = n; this.chairBody.count = n;
    this.chairSteel.instanceMatrix.needsUpdate = true;
    this.chairBody.instanceMatrix.needsUpdate = true;
  }

  // Where the chair a rider boarded at time `phase0` has got to, as a 0..1 parameter.
  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
}
