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

// The in-world panel. It used to sit in front of you the whole time showing speed, clock, gates
// and an edge-angle bar, which is a lot of instrumentation to read while trying to feel a board
// under your feet -- and the one thing you are meant to be reading is the snow. It now shows
// nothing at all until there is something to say, and disappears again when there isn't.
export class Hud {
  constructor() {
    this.panel = new CanvasPanel(640, 150, 0.52);
    this.mesh = this.panel.mesh;
    this.mesh.visible = false;
    this.msg = ''; this.msgUntil = 0; this.sub = '';
    this.state = {};
    this._last = 0; this._drawn = null;
  }
  message(text, sub = '', seconds = 3) { this.msg = text; this.sub = sub; this.msgUntil = performance.now() + seconds * 1000; }
  // `fps` is drawn whenever it is set, message or not. The panel is otherwise invisible until
  // there is something to say, which is the point of it -- but a frame counter you can only read
  // on the desktop is no use at all when the thing being measured is a headset.
  update(s, now) {
    Object.assign(this.state, s);
    const live = this.msg && now < this.msgUntil;
    const key = (live ? this.msg + '|' + this.sub : '') + (this.fps ? '|@' + this.fps : '');
    this.mesh.visible = !!key;
    if (!key || key === this._drawn) return;
    this._drawn = key;
    const { g } = this.panel, W = 640, H = 150;
    this.panel.clear();
    g.fillStyle = 'rgba(8,14,26,0.62)'; roundRect(g, 0, 0, W, H, 26); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2; roundRect(g, 1, 1, W - 2, H - 2, 25); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    if (live) {
      g.fillStyle = 'rgba(255,255,255,0.96)'; g.font = '800 42px Inter, system-ui, sans-serif';
      g.fillText(this.msg, W / 2, this.sub ? 72 : 92);
      if (this.sub) {
        g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '600 24px Inter, system-ui, sans-serif';
        g.fillText(this.sub, W / 2, 112);
      }
    }
    if (this.fps) {
      const n = parseInt(this.fps, 10);
      g.fillStyle = n >= 70 ? '#86efac' : n >= 55 ? '#fde68a' : '#fca5a5';
      g.font = '800 34px Inter, system-ui, sans-serif';
      g.textAlign = live ? 'right' : 'center';
      g.fillText(this.fps, live ? W - 26 : W / 2, live ? 40 : 92);
      g.textAlign = 'center';
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
