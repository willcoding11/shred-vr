// In-headset UI: a canvas-textured HUD panel, a pointable menu panel and a comfort vignette.
import * as THREE from 'three';

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

export class CanvasPanel {
  constructor(w, h, worldW) {
    this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, (worldW * h) / w),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.renderOrder = 50;
    this.w = w; this.h = h;
  }
  clear() { this.g.clearRect(0, 0, this.w, this.h); }
  commit() { this.texture.needsUpdate = true; }
}

export class Hud {
  constructor() {
    this.panel = new CanvasPanel(640, 300, 0.62);
    this.mesh = this.panel.mesh;
    this.msg = ''; this.msgUntil = 0; this.sub = '';
    this.state = { speed: 0, time: 0, gates: 0, gatesTotal: 0, missed: 0, edge: 0, g: 0, air: 0, best: null };
    this._last = 0;
  }
  message(text, sub = '', seconds = 3) { this.msg = text; this.sub = sub; this.msgUntil = performance.now() + seconds * 1000; }
  update(s, now) {
    Object.assign(this.state, s);
    if (now - this._last < 1000 / 20) return;   // 20 fps redraw is plenty
    this._last = now;
    const { g } = this.panel, W = 640, H = 300;
    this.panel.clear();
    g.fillStyle = 'rgba(8,14,26,0.62)'; roundRect(g, 0, 0, W, H, 28); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2; roundRect(g, 1, 1, W - 2, H - 2, 27); g.stroke();
    const st = this.state;
    // speed
    g.fillStyle = '#ffffff'; g.font = '700 92px Inter, system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(Math.round(st.speed * 3.6).toString(), 34, 118);
    g.font = '600 26px Inter, system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.65)';
    g.fillText('km/h', 42 + measure(g, Math.round(st.speed * 3.6).toString(), '700 92px Inter, system-ui, sans-serif'), 118);
    // time
    g.textAlign = 'right'; g.fillStyle = '#ffffff'; g.font = '700 56px Inter, system-ui, sans-serif';
    g.fillText(fmtTime(st.time), W - 34, 96);
    g.font = '600 22px Inter, system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillText(st.best != null ? 'BEST ' + fmtTime(st.best) : 'TIME', W - 34, 126);
    // gates
    g.textAlign = 'left'; g.font = '600 24px Inter, system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(`GATES ${st.gates}/${st.gatesTotal}` + (st.missed ? `  ·  missed ${st.missed}` : ''), 34, 168);
    // edge bar: heel <-> toe
    const bx = 34, by = 196, bw = W - 68, bh = 18;
    g.fillStyle = 'rgba(255,255,255,0.12)'; roundRect(g, bx, by, bw, bh, 9); g.fill();
    const e = Math.max(-1, Math.min(1, st.edge / 70));
    const cx = bx + bw / 2, ex = cx + e * (bw / 2 - 10);
    g.fillStyle = e > 0 ? '#38bdf8' : '#f472b6';
    roundRect(g, Math.min(cx, ex) - 4, by + 2, Math.abs(ex - cx) + 8, bh - 4, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '600 18px Inter, system-ui, sans-serif';
    g.fillText('HEEL', bx, by + 44); g.textAlign = 'right'; g.fillText('TOE', bx + bw, by + 44);
    g.textAlign = 'center';
    const extra = st.slow ? '  ·  SLOW-MO' : st.air > 0.15 ? `  ·  AIR ${st.air.toFixed(1)}s` : '';
    g.fillText(`${Math.abs(st.edge).toFixed(0)}°  ·  ${Math.abs(st.g).toFixed(1)} g` + extra, cx, by + 44);
    // message
    if (this.msg && now < this.msgUntil) {
      g.fillStyle = 'rgba(255,255,255,0.95)'; g.font = '800 34px Inter, system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText(this.msg, W / 2, 278);
    } else if (this.sub) {
      g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = '600 20px Inter, system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText(this.sub, W / 2, 278);
    }
    this.panel.commit();
  }
}
function measure(g, text, font) { const f = g.font; g.font = font; const w = g.measureText(text).width; g.font = f; return w; }
export function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

// A big, pointable menu. Items: [{id,label,value?}] laid out as rows; controllers point + trigger.
export class VrMenu {
  constructor() {
    this.panel = new CanvasPanel(900, 700, 1.1);
    this.mesh = this.panel.mesh;
    this.mesh.material.depthTest = true;
    this.items = []; this.hover = -1; this.visible = false; this.beamLength = 3;
    this.title = 'Shred VR';
    this.mesh.visible = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 5), new THREE.MeshBasicMaterial({ color: 0x9ae6ff, transparent: true, opacity: 0.7 }));
    // the controller's target ray runs down -Z, so the beam has to as well
    this.pointer.geometry.translate(0, -0.5, 0); this.pointer.geometry.rotateX(Math.PI / 2);
    this.pointer.visible = false;
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.dot.renderOrder = 60; this.dot.visible = false;
  }
  setItems(items, title) { this.items = items; if (title) this.title = title; this.draw(); }
  show(v) { this.visible = v; this.mesh.visible = v; this.pointer.visible = v; this.dot.visible = v && this.hover >= 0; if (v) this.draw(); }
  layout() {
    const rows = [], x0 = 60, y0 = 140, w = 780, h = 82, gap = 14;
    this.items.forEach((it, i) => rows.push({ x: x0, y: y0 + i * (h + gap), w, h, it, i }));
    return rows;
  }
  draw() {
    const { g } = this.panel, W = 900, H = 700;
    this.panel.clear();
    g.fillStyle = 'rgba(10,16,30,0.9)'; roundRect(g, 0, 0, W, H, 36); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 3; roundRect(g, 2, 2, W - 4, H - 4, 34); g.stroke();
    g.fillStyle = '#fff'; g.font = '800 54px Inter, system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(this.title, 60, 90);
    for (const r of this.layout()) {
      const hov = r.i === this.hover;
      g.fillStyle = hov ? 'rgba(56,189,248,0.9)' : 'rgba(255,255,255,0.08)';
      roundRect(g, r.x, r.y, r.w, r.h, 20); g.fill();
      g.fillStyle = hov ? '#04121f' : '#fff'; g.font = '700 34px Inter, system-ui, sans-serif'; g.textAlign = 'left';
      g.fillText(r.it.label, r.x + 30, r.y + 53);
      if (r.it.value != null) {
        g.textAlign = 'right'; g.fillStyle = hov ? '#04121f' : 'rgba(255,255,255,0.7)'; g.font = '600 30px Inter, system-ui, sans-serif';
        g.fillText(String(r.it.value), r.x + r.w - 30, r.y + 52);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = '500 22px Inter, system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText('Point and pull the trigger  ·  B / Y closes', W / 2, H - 28);
    this.panel.commit();
  }
  // Ray from a controller (world space). Returns the clicked item id if `click`.
  point(origin, dir, click) {
    if (!this.visible) return null;
    this.raycaster.set(origin, dir);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    let hover = -1;
    if (hit) {
      const uv = hit.uv; const px = uv.x * 900, py = (1 - uv.y) * 700;
      for (const r of this.layout()) if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) hover = r.i;
      this.dot.position.copy(hit.point); this.dot.visible = true;
      this.beamLength = hit.distance;
    } else { this.dot.visible = false; this.beamLength = 3; }
    if (hover !== this.hover) { this.hover = hover; this.draw(); }
    if (click && hover >= 0) return this.items[hover].id;
    return null;
  }
}

// Comfort vignette: a camera-attached ring that darkens the periphery during hard turns.
export class Vignette {
  constructor(camera) {
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false,
      uniforms: { strength: { value: 0 }, radius: { value: 0.9 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform float strength; uniform float radius; varying vec2 vUv;
        void main(){ float d = length((vUv - 0.5) * vec2(1.6, 1.0)) * 2.0; float a = smoothstep(radius * (1.0 - strength * 0.55), 1.15, d) * strength; gl_FragColor = vec4(0.02, 0.03, 0.06, a); }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 100;
    camera.add(this.mesh);
    this.target = 0; this.value = 0;
  }
  update(dt, target) { this.target = target; this.value += (target - this.value) * Math.min(1, dt * 6); this.mat.uniforms.strength.value = this.value; this.mesh.visible = this.value > 0.01; }
}
