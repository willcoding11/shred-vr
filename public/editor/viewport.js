// 3D viewport for the editor: scene, camera, picking on the heightfield, brush cursor,
// markers, the live rider marker and a top-down minimap.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Terrain } from '../shared/terrain.js';
import { PropRenderer, makeStartGate, makeFinishBanner, propGeometries } from '../shared/props.js';
import { Scenery } from '../shared/scenery.js';
import { heightAt, normalAt, slopeDegAt, bounds, PROP_TYPES, gridToWorld } from '../shared/mapformat.js';

// Slab test against the map's bounding box, so a ray that misses the terrain costs nothing.
function raySlab(o, d, b, [y0, y1]) {
  let tmin = 0, tmax = 1e9;
  const lo = [b.minX, y0, b.minZ], hi = [b.maxX, y1, b.maxZ];
  const org = [o.x, o.y, o.z], dir = [d.x, d.y, d.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-9) { if (org[i] < lo[i] || org[i] > hi[i]) return false; continue; }
    let t1 = (lo[i] - org[i]) / dir[i], t2 = (hi[i] - org[i]) / dir[i];
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

export class Viewport {
  constructor(canvas, minimapCanvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 6000);
    this.camera.position.set(0, 120, -80);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons = { MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03; this.controls.minDistance = 4; this.controls.maxDistance = 2500;
    this.controls.zoomSpeed = 1.4;
    this.scenery = new Scenery(this.scene, { shadows: true, shadowSize: 2048 });
    this.scenery.setEnv({ timeOfDay: 0.4, fog: 0.0, snowfall: 0 });
    this.terrain = null; this.props = null; this.map = null;
    this.startGate = null; this.finishBanner = null;
    this.previewEnv = false;
    this.buildCursor();
    this.buildRider();
    this.ghost = null; this.ghostKey = null;
    this.selection = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 8, 40), new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false, transparent: true, opacity: 0.9 }));
    this.selection.rotation.x = Math.PI / 2; this.selection.visible = false; this.selection.renderOrder = 20;
    this.scene.add(this.selection);
    this.minimap = minimapCanvas; this.minimapDirty = true;
    this.raycaster = new THREE.Raycaster();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height; this.camera.updateProjectionMatrix();
  }

  setMap(map, { keepCamera = false } = {}) {
    this.map = map;
    if (!this.terrain) { this.terrain = new Terrain(map, { shadows: true }); this.scene.add(this.terrain.mesh); }
    else this.terrain.setMap(map);
    if (!this.props) { this.props = new PropRenderer(map, { shadows: true }); this.scene.add(this.props.group); }
    else this.props.setMap(map);
    this.refreshMarkers();
    this.applyEnv();
    if (!keepCamera) this.frameStart();
    this.minimapDirty = true;
  }
  applyEnv() {
    if (!this.map) return;
    const e = this.map.env;
    this.scenery.setEnv(this.previewEnv ? e : { timeOfDay: 0.4, fog: 0, snowfall: 0, wind: 0 });
  }
  setColorMode(mode) { if (this.terrain) { this.terrain.colorMode = mode; this.terrain.recolor(); } }

  frameStart() {
    const m = this.map, s = m.start;
    const y = heightAt(m, s.x, s.z);
    this.controls.target.set(s.x, y, s.z + 60);
    this.camera.position.set(s.x + 20, y + 70, s.z - 70);
    this.controls.update();
  }
  frameAll() {
    const b = bounds(this.map), cz = (b.minZ + b.maxZ) / 2;
    const y = heightAt(this.map, 0, cz);
    this.controls.target.set(0, y, cz);
    this.camera.position.set(0, y + (b.maxZ - b.minZ) * 0.9, cz - (b.maxZ - b.minZ) * 0.55);
    this.controls.update();
  }
  lookAtWorld(x, z, dist = 80) {
    const y = heightAt(this.map, x, z);
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    this.controls.target.set(x, y, z);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  refreshMarkers() {
    const m = this.map;
    if (!this.startGate) { this.startGate = makeStartGate(); this.scene.add(this.startGate); }
    this.place(this.startGate, m.start.x, m.start.z, m.start.yaw || 0);
    if (!this.finishBanner || this._finishW !== m.finish.w) {
      if (this.finishBanner) { this.scene.remove(this.finishBanner); this.finishBanner.geometry.dispose(); this.finishBanner.material.dispose(); }
      this.finishBanner = makeFinishBanner(m.finish.w); this._finishW = m.finish.w; this.scene.add(this.finishBanner);
    }
    this.place(this.finishBanner, m.finish.x, m.finish.z, m.finish.yaw || 0);
  }
  place(obj, x, z, yaw) { obj.position.set(x, heightAt(this.map, x, z), z); obj.rotation.y = yaw; obj.castShadow = true; }

  // ---- picking: march a ray against the heightfield ----
  pick(clientX, clientY) {
    if (!this.map) return null;
    const r = this.canvas.getBoundingClientRect();
    const nd = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(nd, this.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    const b = bounds(this.map);
    if (!raySlab(o, d, b, this.mapYRange())) return null;
    let t = 0, step = 1.0, last = null;
    const p = new THREE.Vector3();
    const maxT = 6000;
    // coarse march
    let prevAbove = true;
    for (; t < maxT; t += step) {
      p.copy(o).addScaledVector(d, t);
      if (p.y < -400) return null;
      const inside = p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
      if (!inside) { step = 2.0; prevAbove = true; last = t; continue; }
      const h = heightAt(this.map, p.x, p.z);
      const above = p.y > h;
      if (!above && prevAbove && last != null) {
        // refine between last and t
        let a = last, c = t;
        for (let i = 0; i < 14; i++) {
          const mid = (a + c) / 2; p.copy(o).addScaledVector(d, mid);
          if (p.y > heightAt(this.map, p.x, p.z)) a = mid; else c = mid;
        }
        p.copy(o).addScaledVector(d, c);
        return { x: p.x, z: p.z, y: heightAt(this.map, p.x, p.z), slope: slopeDegAt(this.map, p.x, p.z) };
      }
      prevAbove = above; last = t;
      step = Math.max(0.35, Math.min(4, (p.y - h) * 0.5));
    }
    return null;
  }

  // Vertical extent of the heightfield, cached per map (used to reject rays cheaply).
  mapYRange() {
    // Invalidate on edits too, not just on a map swap: heavy sculpting otherwise pushes the
    // terrain outside the cached slab and picking silently stops working.
    if (this._yRange && this._yMap === this.map && performance.now() - this._yAt < 3000) return this._yRange;
    this._yAt = performance.now();
    let lo = Infinity, hi = -Infinity;
    const H = this.map.heights;
    for (let i = 0; i < H.length; i += 7) { if (H[i] < lo) lo = H[i]; if (H[i] > hi) hi = H[i]; }
    this._yMap = this.map; this._yRange = [lo - 30, hi + 30];
    return this._yRange;
  }

  // ---- brush cursor ----
  buildCursor() {
    const seg = 64;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((seg + 1) * 3), 3));
    this.cursor = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.95, depthTest: false }));
    this.cursor.renderOrder = 30; this.cursor.frustumCulled = false; this.cursor.visible = false;
    this.cursorInner = new THREE.Line(g.clone(), new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35, depthTest: false }));
    this.cursorInner.renderOrder = 30; this.cursorInner.frustumCulled = false; this.cursorInner.visible = false;
    const ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
    this.cursorArrow = new THREE.Line(ag, new THREE.LineBasicMaterial({ color: 0xfacc15, depthTest: false }));
    this.cursorArrow.renderOrder = 31; this.cursorArrow.frustumCulled = false; this.cursorArrow.visible = false;
    this.scene.add(this.cursor, this.cursorInner, this.cursorArrow);
  }
  updateCursor(hit, radius, { color = 0x38bdf8, falloff = 0.5, yaw = null, visible = true } = {}) {
    if (!hit || !visible) { this.cursor.visible = this.cursorInner.visible = this.cursorArrow.visible = false; return; }
    this.cursor.visible = true; this.cursorInner.visible = falloff < 0.98;
    this.cursor.material.color.setHex(color); this.cursorInner.material.color.setHex(color);
    const seg = 64;
    for (const [line, rr] of [[this.cursor, radius], [this.cursorInner, radius * falloff]]) {
      const a = line.geometry.attributes.position.array;
      for (let i = 0; i <= seg; i++) {
        const ang = (i / seg) * Math.PI * 2, x = hit.x + Math.cos(ang) * rr, z = hit.z + Math.sin(ang) * rr;
        a[i * 3] = x; a[i * 3 + 1] = heightAt(this.map, x, z) + 0.25; a[i * 3 + 2] = z;
      }
      line.geometry.attributes.position.needsUpdate = true;
    }
    if (yaw != null) {
      this.cursorArrow.visible = true;
      const a = this.cursorArrow.geometry.attributes.position.array;
      a[0] = hit.x; a[1] = hit.y + 0.4; a[2] = hit.z;
      a[3] = hit.x + Math.sin(yaw) * radius; a[4] = heightAt(this.map, hit.x + Math.sin(yaw) * radius, hit.z + Math.cos(yaw) * radius) + 0.4; a[5] = hit.z + Math.cos(yaw) * radius;
      this.cursorArrow.geometry.attributes.position.needsUpdate = true;
    } else this.cursorArrow.visible = false;
  }

  // ---- ghost of the prop being placed ----
  updateGhost(type, hit, scale = 1, rot = 0) {
    const key = type === 'gate' ? 'gateA' : type;
    if (!hit || !PROP_TYPES[type]) { if (this.ghost) this.ghost.visible = false; return; }
    if (this.ghostKey !== key) {
      if (this.ghost) this.scene.remove(this.ghost);
      this.ghost = new THREE.Mesh(propGeometries()[key], new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }));
      this.ghostKey = key; this.scene.add(this.ghost);
    }
    this.ghost.visible = true;
    this.ghost.position.set(hit.x, hit.y, hit.z); this.ghost.rotation.set(0, rot, 0); this.ghost.scale.setScalar(scale);
  }
  hideGhost() { if (this.ghost) this.ghost.visible = false; }
  showSelection(prop) {
    if (!prop) { this.selection.visible = false; return; }
    const def = PROP_TYPES[prop.t] || { r: 1 };
    const r = Math.max(1.2, (def.r || 1) * (prop.s || 1) * 1.6, prop.t === 'gate' ? 4 : 0);
    this.selection.visible = true; this.selection.scale.setScalar(r);
    this.selection.position.set(prop.x, heightAt(this.map, prop.x, prop.z) + 0.3, prop.z);
  }

  // ---- live rider marker ----
  buildRider() {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.4, 12), new THREE.MeshStandardMaterial({ color: 0xf472b6, emissive: 0xf472b6, emissiveIntensity: 0.5 }));
    cone.rotation.x = Math.PI / 2; cone.position.y = 1.2; g.add(cone);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.12, 8, 32), new THREE.MeshBasicMaterial({ color: 0xf472b6, transparent: true, opacity: 0.7, depthTest: false }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.2; g.add(ring);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 40, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xf472b6, transparent: true, opacity: 0.25, depthWrite: false }));
    beam.position.y = 20; g.add(beam);
    g.visible = false; this.rider = g; this.riderState = null; this.scene.add(g);
  }
  setRider(t) {
    if (!t || !this.map || t.id !== this.map.id) { this.rider.visible = false; this.riderState = null; return; }
    this.riderState = t; this.rider.visible = true; this._riderSeen = performance.now();
    this.rider.position.set(t.x, heightAt(this.map, t.x, t.z), t.z); this.rider.rotation.y = t.yaw;
  }
  // Telemetry arrives ~8x/s; if it stops, the rider has left.
  ageRider() {
    if (this.rider.visible && performance.now() - (this._riderSeen || 0) > 2500) {
      this.rider.visible = false; this.riderState = null; return true;
    }
    return false;
  }

  // ---- minimap ----
  drawMinimap() {
    const c = this.minimap; if (!c || !this.map) return;
    const m = this.map, { w, h } = m.size;
    const scale = Math.min(c.width / w, c.height / h);
    const g = c.getContext('2d');
    if (this.minimapDirty) {
      this.minimapImg = g.createImageData(w, h);
      const d = this.minimapImg.data, nrm = [0, 1, 0];
      for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
        const [wx, wz] = gridToWorld(m, x, z);
        normalAt(m, wx, wz, nrm);
        const s = Math.acos(Math.min(1, nrm[1])) * 57.3;
        const shade = 0.6 + 0.4 * Math.max(0, nrm[0] * -0.4 + nrm[1] * 0.8 + nrm[2] * -0.4);
        let r = 235, gg = 240, b = 250;
        if (s > 45) { r = 190; gg = 60; b = 60; } else if (s > 32) { r = 250; gg = 170; b = 70; } else if (s > 20) { r = 130; gg = 170; b = 245; } else if (s > 10) { r = 190; gg = 210; b = 250; }
        const i = (z * w + x) * 4; d[i] = r * shade; d[i + 1] = gg * shade; d[i + 2] = b * shade; d[i + 3] = 255;
      }
      this.minimapDirty = false; this._mmPainted = false;
    }
    g.clearRect(0, 0, c.width, c.height);
    let off = this._mmOff;
    if (!off || off.width !== w || off.height !== h) {
      off = this._mmOff = document.createElement('canvas'); off.width = w; off.height = h;
      this._mmCtx = off.getContext('2d'); this._mmPainted = false;
    }
    if (!this._mmPainted) { this._mmCtx.putImageData(this.minimapImg, 0, 0); this._mmPainted = true; }
    g.imageSmoothingEnabled = true;
    const ox = (c.width - w * scale) / 2, oy = (c.height - h * scale) / 2;
    g.drawImage(off, ox, oy, w * scale, h * scale);
    const toPx = (x, z) => [ox + (x / m.spacing + (w - 1) / 2) * scale, oy + (z / m.spacing) * scale];
    for (const p of m.props) {
      const def = PROP_TYPES[p.t]; if (!def) continue;
      const [px, py] = toPx(p.x, p.z);
      g.fillStyle = def.color; g.beginPath(); g.arc(px, py, p.t === 'gate' ? 2 : 1.2, 0, 7); g.fill();
    }
    const [sx, sy] = toPx(m.start.x, m.start.z); g.fillStyle = '#22c55e'; g.beginPath(); g.arc(sx, sy, 3.5, 0, 7); g.fill();
    const [fx, fy] = toPx(m.finish.x, m.finish.z); g.strokeStyle = '#ef4444'; g.lineWidth = 2; g.beginPath(); g.moveTo(fx - (m.finish.w / 2 / m.spacing) * scale, fy); g.lineTo(fx + (m.finish.w / 2 / m.spacing) * scale, fy); g.stroke();
    // camera target + rider
    const [cx, cy] = toPx(this.controls.target.x, this.controls.target.z);
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, 5, 0, 7); g.stroke();
    if (this.riderState) { const [rx, ry] = toPx(this.riderState.x, this.riderState.z); g.fillStyle = '#f472b6'; g.beginPath(); g.arc(rx, ry, 4, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.stroke(); }
    this.minimapGeom = { ox, oy, scale };
  }
  minimapToWorld(px, py) {
    const g = this.minimapGeom, m = this.map; if (!g) return null;
    const gx = (px - g.ox) / g.scale, gz = (py - g.oy) / g.scale;
    const [x, z] = gridToWorld(m, gx, gz);
    const b = bounds(m);
    return { x: THREE.MathUtils.clamp(x, b.minX, b.maxX), z: THREE.MathUtils.clamp(z, b.minZ, b.maxZ) };
  }

  render(dt) {
    this.controls.update();
    this.ageRider();
    this.scenery.update(dt, this.controls.target, this.camera);
    this.renderer.render(this.scene, this.camera);
  }
}
