// Low-poly prop geometry + instanced rendering shared by the game and the editor.
import * as THREE from 'three';
import { realConifer, realBirch } from './realism.js';
import { mergeGeometries as _merge } from 'three/addons/utils/BufferGeometryUtils.js';
// Merge that tolerates a mix of indexed / non-indexed parts.
const mergeGeometries = (parts) => _merge(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
import { PROP_TYPES, heightAt, normalAt } from './mapformat.js';

const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion();
const tmpS = new THREE.Vector3(), tmpE = new THREE.Euler(), UP = new THREE.Vector3(0, 1, 0), tmpN = new THREE.Vector3();

function colored(geo, hex) {
  const c = new THREE.Color(hex), n = geo.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
const move = (g, x, y, z) => g.translate(x, y, z);
const rotY = (g, a) => g.rotateY(a);

function pine() {
  const parts = [];
  parts.push(colored(new THREE.CylinderGeometry(0.18, 0.28, 1.6, 6), '#5b3a1e').translate(0, 0.8, 0));
  const tiers = [[2.6, 1.9, 1.4], [2.2, 1.6, 3.0], [1.7, 1.3, 4.4], [1.1, 1.0, 5.5]];
  tiers.forEach(([r, h, y], i) => parts.push(colored(new THREE.ConeGeometry(r, h, 7), i % 2 ? '#2b6b3a' : '#2f7a42').translate(0, y + h / 2 - 0.4, 0)));
  parts.push(colored(new THREE.ConeGeometry(0.9, 0.5, 7), '#eef4ff').translate(0, 3.05, 0)); // snow cap on tier
  parts.push(colored(new THREE.ConeGeometry(0.55, 0.35, 7), '#eef4ff').translate(0, 5.65, 0));
  return mergeGeometries(parts);
}
function fir() {
  const parts = [colored(new THREE.CylinderGeometry(0.15, 0.22, 1.2, 6), '#4a2e17').translate(0, 0.6, 0)];
  for (let i = 0; i < 6; i++) {
    const t = i / 5, r = 1.9 * (1 - t) + 0.25, h = 1.5, y = 1.0 + i * 1.1;
    parts.push(colored(new THREE.ConeGeometry(r, h, 7), i % 2 ? '#1f5a3c' : '#236646').translate(0, y + h / 2, 0));
    if (i % 2 === 0) parts.push(colored(new THREE.ConeGeometry(r * 0.55, 0.3, 7), '#f1f6ff').translate(0, y + h - 0.05, 0));
  }
  return mergeGeometries(parts);
}
function birch() {
  const parts = [colored(new THREE.CylinderGeometry(0.12, 0.2, 7, 6), '#e7e2d8').translate(0, 3.5, 0)];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.1, y = 3.2 + i * 0.8;
    const br = colored(new THREE.CylinderGeometry(0.03, 0.07, 1.6, 4), '#d9d2c5');
    br.rotateZ(0.9 + (i % 2) * 0.3); br.rotateY(a); br.translate(Math.cos(a) * 0.55, y, Math.sin(a) * 0.55);
    parts.push(br);
  }
  return mergeGeometries(parts);
}
function rockGeo(r, hex, seed) {
  const g = new THREE.DodecahedronGeometry(r, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 0.85 + 0.3 * (((Math.sin(i * 12.9 + seed) * 43758.5) % 1 + 1) % 1);
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.75, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  const c = colored(g, hex);
  // dust snow on the top faces
  const col = c.attributes.color, n = c.attributes.normal;
  for (let i = 0; i < p.count; i++) if (n.getY(i) > 0.6) col.setXYZ(i, 0.93, 0.95, 0.99);
  return c.translate(0, r * 0.35, 0);
}
function gate(hex) {
  const parts = [];
  const w = PROP_TYPES.gate.width;
  for (const s of [-1, 1]) parts.push(colored(new THREE.CylinderGeometry(0.045, 0.045, 2.4, 6), hex).translate(s * w / 2, 1.2, 0));
  parts.push(colored(new THREE.BoxGeometry(w, 0.7, 0.02), hex).translate(0, 1.8, 0));
  return mergeGeometries(parts);
}
function flag() {
  const parts = [colored(new THREE.CylinderGeometry(0.03, 0.04, 2.2, 5), '#1f2937').translate(0, 1.1, 0)];
  const f = new THREE.BufferGeometry();
  f.setAttribute('position', new THREE.Float32BufferAttribute([0, 2.2, 0, 0.7, 2.0, 0, 0, 1.75, 0, 0, 2.2, 0, 0, 1.75, 0, 0.7, 2.0, 0], 3));
  f.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(12), 2));
  f.computeVertexNormals();
  parts.push(colored(f, '#f59e0b'));
  return mergeGeometries(parts);
}
function fence() {
  const parts = [], len = PROP_TYPES.fence.len;
  for (let i = -1; i <= 1; i++) parts.push(colored(new THREE.BoxGeometry(0.12, 1.1, 0.12), '#8a5a2b').translate(i * len / 2, 0.55, 0));
  parts.push(colored(new THREE.BoxGeometry(len, 0.08, 0.06), '#b0773a').translate(0, 0.95, 0));
  parts.push(colored(new THREE.BoxGeometry(len, 0.08, 0.06), '#b0773a').translate(0, 0.55, 0));
  return mergeGeometries(parts);
}
function lamp() {
  const parts = [colored(new THREE.CylinderGeometry(0.06, 0.09, 3.2, 6), '#1f2937').translate(0, 1.6, 0)];
  parts.push(colored(new THREE.SphereGeometry(0.28, 8, 6), '#ffe7a0').translate(0, 3.35, 0));
  parts.push(colored(new THREE.ConeGeometry(0.42, 0.3, 8), '#111827').translate(0, 3.65, 0));
  return mergeGeometries(parts);
}
function sign() {
  const parts = [colored(new THREE.BoxGeometry(0.12, 2.0, 0.12), '#5b3a1e').translate(0, 1.0, 0)];
  parts.push(colored(new THREE.BoxGeometry(1.4, 0.6, 0.06), '#7c2d12').translate(0, 1.9, 0));
  parts.push(colored(new THREE.BoxGeometry(1.2, 0.4, 0.02), '#fde68a').translate(0, 1.9, 0.04));
  return mergeGeometries(parts);
}
function snowman() {
  const parts = [colored(new THREE.SphereGeometry(0.75, 10, 8), '#f8fafc').translate(0, 0.7, 0)];
  parts.push(colored(new THREE.SphereGeometry(0.55, 10, 8), '#f8fafc').translate(0, 1.75, 0));
  parts.push(colored(new THREE.SphereGeometry(0.4, 10, 8), '#f8fafc').translate(0, 2.55, 0));
  parts.push(colored(new THREE.CylinderGeometry(0.28, 0.28, 0.4, 8), '#111827').translate(0, 3.05, 0));
  parts.push(colored(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 8), '#111827').translate(0, 2.87, 0));
  parts.push(colored(new THREE.ConeGeometry(0.06, 0.35, 5), '#f97316').rotateX(Math.PI / 2).translate(0, 2.55, 0.5));
  return mergeGeometries(parts);
}
// A park box: a steel-topped slab on short legs, ramped at both ends so you can ride straight on.
// Built from the same numbers the terrain uses for its surface (PROP_TYPES.rail), so what you see
// and what you ride are the same object.
function rail() {
  const d = PROP_TYPES.rail, L = d.len, W = d.railW, H = d.railH;
  const ramp = Math.min(1.4, L * 0.28);
  const parts = [colored(new THREE.BoxGeometry(W, 0.1, L), '#aeb8c6').translate(0, H - 0.05, 0)];
  for (const end of [-1, 1]) {
    const w = colored(new THREE.BoxGeometry(W, H, ramp), '#aeb8c6');
    const pos = w.attributes.position;
    for (let i = 0; i < pos.count; i++) if (Math.sign(pos.getZ(i)) === end) pos.setY(i, -H / 2);
    w.computeVertexNormals();
    parts.push(w.translate(0, H / 2, end * (L / 2 - ramp / 2)));
  }
  for (const sx of [-1, 1]) {
    parts.push(colored(new THREE.BoxGeometry(0.05, H - 0.1, L - ramp * 2), '#6b7280')
      .translate(sx * (W / 2 - 0.02), (H - 0.1) / 2, 0));
  }
  for (const tz of [-0.34, 0, 0.34]) for (const sx of [-1, 1]) {
    parts.push(colored(new THREE.BoxGeometry(0.07, H, 0.07), '#4b5563')
      .translate(sx * (W / 2 - 0.06), H / 2, tz * (L - ramp * 2)));
  }
  return mergeGeometries(parts);
}

function hut() {
  const parts = [colored(new THREE.BoxGeometry(5, 2.6, 4), '#7a4a22').translate(0, 1.3, 0)];
  const roof = colored(new THREE.CylinderGeometry(0, 3.6, 1.8, 4, 1), '#3b2a1a');
  roof.rotateY(Math.PI / 4); roof.scale(1.15, 1, 0.95); roof.translate(0, 3.5, 0);
  parts.push(roof);
  parts.push(colored(new THREE.CylinderGeometry(0, 3.9, 0.35, 4, 1), '#f3f6fb').rotateY(Math.PI / 4).translate(0, 3.85, 0));
  parts.push(colored(new THREE.BoxGeometry(0.9, 1.6, 0.1), '#fbbf24').translate(1.2, 0.9, 2.02));
  parts.push(colored(new THREE.BoxGeometry(0.9, 0.9, 0.1), '#93c5fd').translate(-1.2, 1.5, 2.02));
  parts.push(colored(new THREE.BoxGeometry(0.5, 0.5, 1.2), '#57534e').translate(1.5, 4.0, -0.8));
  return mergeGeometries(parts);
}

const rnd = (seed) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; };

// SEVERAL OF EACH SPECIES, not one.
//
// The random source used to be drawn once per species, so realConifer produced exactly one pine
// geometry and it was instanced four hundred and seventy-nine times: in any shot of a stand you
// could read the same white snow collars in the same places on tier 3 and tier 7 of every tree in
// frame. Four geometries per conifer and three per birch is eleven extra draw calls in total, and
// it is the difference between a forest and wallpaper.
// The cheapest tree that still reads as a tree, for the ones a long way off. A real conifer here
// is about 340 triangles and there are nine hundred of them on a map; at three hundred metres you
// cannot tell this from that, and it is sixteen.
function farConifer(dark = false) {
  const parts = [
    colored(new THREE.CylinderGeometry(0.09, 0.16, 2.2, 3), '#43331f').translate(0, 1.1, 0),
    colored(new THREE.ConeGeometry(1.5, 6.4, 5), dark ? '#1d4a33' : '#2c5f3a').translate(0, 5.0, 0),
  ];
  return mergeGeometries(parts);
}
function farBirch() {
  return mergeGeometries([
    colored(new THREE.CylinderGeometry(0.08, 0.13, 4.2, 3), '#d9d2c5').translate(0, 2.1, 0),
    colored(new THREE.ConeGeometry(1.2, 3.4, 5), '#8aa06a').translate(0, 4.6, 0),
  ]);
}

let vcache = null, vcacheQ = null;
export function propVariants(quality = 'fast') {
  if (vcache && vcacheQ === quality) return vcache;
  if (vcache) for (const list of Object.values(vcache)) for (const g of list) g.dispose();
  vcacheQ = quality;
  const mk = (n, f) => Array.from({ length: n }, (_, i) => { const g = f(i); g.computeBoundingSphere(); return g; });
  vcache = quality === 'real' ? {
    pine: mk(4, (i) => mergeGeometries(realConifer({ height: 7.3 + i * 0.75, rand: rnd(101 + i * 977), snowy: 0.56 + i * 0.10 }))),
    fir: mk(4, (i) => mergeGeometries(realConifer({ height: 9.1 + i * 0.85, rand: rnd(313 + i * 641), snowy: 0.68 + i * 0.08, dark: true }))),
    birch: mk(3, (i) => mergeGeometries(realBirch({ height: 6.2 + i * 0.85, rand: rnd(57 + i * 433) }))),
  } : { pine: mk(1, () => pine()), fir: mk(1, () => fir()), birch: mk(1, () => birch()) };
  return vcache;
}

let cache = null, cacheQuality = null;
export function propGeometries(quality = 'fast') {
  if (cache && cacheQuality === quality) return cache;
  const keep = new Set(Object.values(vcache || {}).flat());
  if (cache) for (const g of Object.values(cache)) if (!keep.has(g)) g.dispose();
  cacheQuality = quality;
  const v = propVariants(quality);
  cache = {
    pine: v.pine[0], fir: v.fir[0], birch: v.birch[0],
    // the two cheaper tiers the renderer swaps in with distance
    'pine:mid': pine(), 'fir:mid': fir(), 'birch:mid': birch(),
    'pine:far': farConifer(false), 'fir:far': farConifer(true), 'birch:far': farBirch(),
    rock: rockGeo(1.0, '#6b7280', 1), boulder: rockGeo(2.4, '#4b5563', 7),
    gateA: gate('#ef4444'), gateB: gate('#3b82f6'),
    flag: flag(), fence: fence(), lamp: lamp(), sign: sign(), snowman: snowman(), hut: hut(), rail: rail(),
  };
  for (const g of Object.values(cache)) g.computeBoundingSphere();
  return cache;
}

// Renders map.props as instanced meshes, in distance tiers, and only the ones near enough to see.
//
// This used to be one InstancedMesh per geometry with frustumCulled = false and every instance
// drawn, which on the open mountain measured 347,000 triangles of tree submitted every frame for
// both eyes -- four times the entire terrain. Nothing was culled because an InstancedMesh covering
// a square kilometre has a bounding sphere covering a square kilometre, so three.js can never
// reject it; the culling has to be done per instance, here.
//
// Three tiers: the full mesh close up, the Fast preset's own cheap geometry in the middle
// distance (it already exists, and at a hundred and fifty metres it is indistinguishable), and a
// cone on a stick beyond that. Rebuilt only when the viewer has actually moved.
const TIER_NEAR = 110, TIER_MID = 280, TIER_FAR = 520, TIER_PROP = 460;
const _ORIGIN = new THREE.Vector3();

export class PropRenderer {
  constructor(map, { shadows = true, quality = 'fast', lod = true } = {}) {
    this.map = map; this.shadows = shadows; this.quality = quality; this.lod = lod;
    this.group = new THREE.Group(); this.group.name = 'props';
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    this.lampMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0xffd27a, emissiveIntensity: 0.35 });
    this.meshes = {};
    this.items = [];
    this._last = new THREE.Vector3(1e9, 1e9, 1e9);
    this.sync();
  }
  setMap(map) { this.map = map; this.sync(); }

  // Trees are spread across the variant geometries BY POSITION, so a given tree is always the
  // same tree: re-syncing after an edit must not reshuffle the forest.
  geoKey(p, gateIndex) {
    if (p.t === 'gate') return gateIndex % 2 ? 'gateB' : 'gateA';
    const v = propVariants(this.quality)[p.t];
    if (!v || v.length < 2) return p.t;
    return p.t + '#' + (Math.abs(Math.round(p.x * 7.31 + p.z * 13.17)) % v.length);
  }

  // Everything that does not change as you move: the world matrix and the tint of every prop, and
  // which mesh it belongs to at each tier. Done once, so the per-frame pass is only a copy.
  sync() {
    const geos = propGeometries(this.quality);
    const vars = propVariants(this.quality);
    this.items = [];
    const caps = {};
    let gi = 0;
    for (const p of this.map.props) {
      if (!PROP_TYPES[p.t]) continue;
      const tree = p.t === 'pine' || p.t === 'fir' || p.t === 'birch';
      const near = this.geoKey(p, p.t === 'gate' ? gi++ : 0);
      // With lod off there is only ever the full mesh, so the cheaper tiers are not even built.
      const keys = tree && this.lod ? [near, p.t + '@mid', p.t + '@far'] : [near];
      const s = p.s || 1;
      const y = heightAt(this.map, p.x, p.z) - (p.t === 'rail' ? 0 : 0.05) - (tree ? 0.30 * s : 0);
      tmpP.set(p.x, y, p.z);
      if (tree || p.t === 'lamp' || p.t === 'sign' || p.t === 'snowman' || p.t === 'rail') {
        tmpQ.setFromEuler(tmpE.set(0, p.r || 0, 0));
      } else {
        const n = normalAt(this.map, p.x, p.z);
        tmpN.set(n[0], n[1], n[2]);
        tmpQ.setFromUnitVectors(UP, tmpN);
        tmpQ2.setFromEuler(tmpE.set(0, p.r || 0, 0));
        tmpQ.multiply(tmpQ2);
      }
      tmpS.set(s, s, s);
      tmpM.compose(tmpP, tmpQ, tmpS);
      const j = ((Math.sin(p.x * 91.7 + p.z * 47.3) * 43758.5453) % 1 + 1) % 1;
      const v = 0.90 + j * 0.20;
      this.items.push({ x: p.x, z: p.z, keys, m: tmpM.elements.slice(),
                        c: [v * (1 - j * 0.05), v, v * (0.97 + j * 0.06)] });
      for (const k of keys) caps[k] = (caps[k] || 0) + 1;
    }
    // (re)build the meshes to fit
    for (const key of Object.keys(this.meshes)) {
      if (!caps[key]) { this.group.remove(this.meshes[key]); this.meshes[key].dispose(); delete this.meshes[key]; }
    }
    for (const [key, cap] of Object.entries(caps)) {
      let m = this.meshes[key];
      if (m && m.userData.cap >= cap && m.userData.cap < cap * 4 + 64) continue;
      if (m) { this.group.remove(m); m.dispose(); }
      const at = key.indexOf('@'), hash = key.indexOf('#');
      let geo;
      if (at > 0) geo = geos[key.slice(0, at) + (key.endsWith('@mid') ? ':mid' : ':far')];
      else if (hash > 0) geo = vars[key.slice(0, hash)][+key.slice(hash + 1)];
      else geo = geos[key];
      m = new THREE.InstancedMesh(geo, key === 'lamp' ? this.lampMat : this.material, cap);
      m.userData.cap = cap;
      // Per-instance tint. Every conifer was the identical green, because one material with no
      // instanceColor is one colour however many variants of the mesh you build.
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      // Only the near tier casts. A tree two hundred metres away casts a shadow you will never
      // identify, and it costs a second draw of itself every frame to do it.
      m.castShadow = this.shadows && key.indexOf('@') < 0;
      m.receiveShadow = this.shadows;   // a forest where no tree shadows another is a flat cutout
      m.frustumCulled = false;          // we decide, per instance, in cull()
      m.name = 'prop:' + key;
      this.group.add(m); this.meshes[key] = m;
    }
    this._last.set(1e9, 1e9, 1e9);
    this._placed = false;
    this.cull(this._viewer, true);
  }

  // Which props draw, and at which tier. Cheap enough to call every frame, but it only does the
  // work when the viewer has moved far enough for an answer to have changed.
  cull(viewerPos, force = false) {
    // With lod off nothing depends on where you are, so this runs once after a sync and then
    // never again -- and it does not need a viewer position at all, which is how the editor
    // calls it.
    if (!this.lod) {
      if (this._placed && !force) return;
      this._placed = true;
      viewerPos = _ORIGIN;
    } else {
      if (!viewerPos) return;
      this._viewer = this._viewer || new THREE.Vector3();
      this._viewer.copy(viewerPos);
      if (!force && this._last.distanceToSquared(viewerPos) < 144) return;   // 12 m
      this._last.copy(viewerPos);
    }
    const counts = {};
    for (const m of Object.values(this.meshes)) counts[m.name.slice(5)] = 0;
    const vx = viewerPos.x, vz = viewerPos.z;
    for (const it of this.items) {
      const d = Math.hypot(it.x - vx, it.z - vz);
      let key;
      if (!this.lod) key = it.keys[0];
      else if (it.keys.length === 1) { if (d > TIER_PROP) continue; key = it.keys[0]; }
      else if (d < TIER_NEAR) key = it.keys[0];
      else if (d < TIER_MID) key = it.keys[1];
      else if (d < TIER_FAR) key = it.keys[2];
      else continue;
      const m = this.meshes[key]; if (!m) continue;
      const i = counts[key]++;
      if (i >= m.userData.cap) { counts[key]--; continue; }
      m.instanceMatrix.array.set(it.m, i * 16);
      if (m.instanceColor) m.instanceColor.array.set(it.c, i * 3);
    }
    for (const [key, m] of Object.entries(this.meshes)) {
      m.count = counts[key] || 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}

// Start gate + finish banner (built from map.start / map.finish rather than props).
export function makeStartGate() {
  const parts = [];
  for (const s of [-1, 1]) parts.push(colored(new THREE.CylinderGeometry(0.12, 0.14, 3.2, 8), '#e5e7eb').translate(s * 3, 1.6, 0));
  parts.push(colored(new THREE.BoxGeometry(6.4, 0.9, 0.08), '#22c55e').translate(0, 3.4, 0));
  parts.push(colored(new THREE.BoxGeometry(6.6, 0.12, 0.14), '#e5e7eb').translate(0, 3.9, 0));
  const g = mergeGeometries(parts);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
}
export function makeFinishBanner(width = 30) {
  const parts = [];
  for (const s of [-1, 1]) parts.push(colored(new THREE.CylinderGeometry(0.16, 0.2, 5, 8), '#111827').translate(s * width / 2, 2.5, 0));
  parts.push(colored(new THREE.BoxGeometry(width, 1.4, 0.08), '#ef4444').translate(0, 5.2, 0));
  const checks = [];
  const n = Math.max(6, Math.round(width / 1.5));
  for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2 === 0) {
    checks.push(colored(new THREE.BoxGeometry(width / n, 0.7, 0.09), '#f8fafc').translate(-width / 2 + (i + 0.5) * width / n, 4.85 + j * 0.7, 0));
  }
  parts.push(...checks);
  const g = mergeGeometries(parts);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
}
