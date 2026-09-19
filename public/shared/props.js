// Low-poly prop geometry + instanced rendering shared by the game and the editor.
import * as THREE from 'three';
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

let cache = null;
export function propGeometries() {
  if (cache) return cache;
  cache = {
    pine: pine(), fir: fir(), birch: birch(),
    rock: rockGeo(1.0, '#6b7280', 1), boulder: rockGeo(2.4, '#4b5563', 7),
    gateA: gate('#ef4444'), gateB: gate('#3b82f6'),
    flag: flag(), fence: fence(), lamp: lamp(), sign: sign(), snowman: snowman(), hut: hut(),
  };
  for (const g of Object.values(cache)) g.computeBoundingSphere();
  return cache;
}

// Renders map.props as one InstancedMesh per geometry. Call sync() after any change.
export class PropRenderer {
  constructor(map, { shadows = true } = {}) {
    this.map = map; this.shadows = shadows;
    this.group = new THREE.Group(); this.group.name = 'props';
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    this.lampMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0xffd27a, emissiveIntensity: 0.35 });
    this.meshes = {};
    this.sync();
  }
  setMap(map) { this.map = map; this.sync(); }
  geoKey(p, gateIndex) { return p.t === 'gate' ? (gateIndex % 2 ? 'gateB' : 'gateA') : p.t; }
  sync() {
    const geos = propGeometries();
    const buckets = {};
    let gi = 0;
    for (const p of this.map.props) {
      if (!PROP_TYPES[p.t]) continue;
      const key = this.geoKey(p, p.t === 'gate' ? gi++ : 0);
      (buckets[key] ||= []).push(p);
    }
    for (const key of Object.keys(this.meshes)) {
      if (!buckets[key]) { this.group.remove(this.meshes[key]); this.meshes[key].dispose(); delete this.meshes[key]; }
    }
    for (const [key, list] of Object.entries(buckets)) {
      let m = this.meshes[key];
      if (!m || m.userData.cap < list.length || m.userData.cap > list.length * 4 + 64) {
        if (m) { this.group.remove(m); m.dispose(); }
        const cap = Math.ceil(list.length * 1.5) + 16;
        m = new THREE.InstancedMesh(geos[key], key === 'lamp' ? this.lampMat : this.material, cap);
        m.userData.cap = cap;
        m.castShadow = this.shadows; m.receiveShadow = false;
        m.frustumCulled = false;
        m.name = 'prop:' + key;
        this.group.add(m); this.meshes[key] = m;
      }
      m.count = list.length;
      list.forEach((p, i) => {
        const y = heightAt(this.map, p.x, p.z) - 0.05;
        const s = p.s || 1;
        tmpP.set(p.x, y, p.z);
        // trees stand straight, everything else tilts with the ground a little
        if (p.t === 'pine' || p.t === 'fir' || p.t === 'birch' || p.t === 'lamp' || p.t === 'sign' || p.t === 'snowman') {
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
        m.setMatrixAt(i, tmpM);
      });
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
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
