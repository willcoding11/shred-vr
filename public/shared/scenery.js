// Sky, sun, distant peaks, fog and falling snow. Shared by game + editor.
import * as THREE from 'three';
import { fbm } from './mapformat.js';

const skyVert = `
varying vec3 vDir;
void main(){ vDir = normalize((modelMatrix * vec4(position,1.0)).xyz - cameraPosition); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const skyFrag = `
uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunSize;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float t = clamp(d.y, -0.05, 1.0);
  float f = pow(1.0 - t, 2.2);
  vec3 col = mix(zenith, horizon, f);
  float sd = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(sd, 900.0 * sunSize) * 1.4 + pow(sd, 24.0) * 0.25 + pow(sd, 4.0) * 0.08);
  gl_FragColor = vec4(col, 1.0);
}`;

export class Scenery {
  constructor(scene, { shadows = true, shadowSize = 2048, mountains = true } = {}) {
    this.scene = scene;
    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      const c = this.sun.shadow.camera;
      // a tighter frustum around the rider: ~7 cm/texel at 2048 instead of ~10 cm
      c.left = -75; c.right = 75; c.top = 75; c.bottom = -75; c.near = 1; c.far = 420;
      this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.6;
    }
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sun, this.sunTarget); this.sun.target = this.sunTarget;
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0xcfd8e3, 0.6);
    scene.add(this.hemi);

    this.skyUniforms = {
      zenith: { value: new THREE.Color(0x3d7dd8) }, horizon: { value: new THREE.Color(0xdbe8f7) },
      sunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2).normalize() }, sunColor: { value: new THREE.Color(0xfff2d0) },
      sunSize: { value: 1.0 },
    };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.skyUniforms, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    this.sky.renderOrder = -10; this.sky.frustumCulled = false;
    scene.add(this.sky);

    scene.fog = new THREE.Fog(0xdbe8f7, 200, 1400);
    if (mountains) scene.add(this.mountains = makeMountains());
    this.snow = makeSnowfall(); scene.add(this.snow.points);
    this.env = {};
    this.setEnv({ timeOfDay: 0.35, fog: 0.35, snowfall: 0.2 });
  }

  setEnv(env) {
    this.env = { ...this.env, ...env };
    const t = this.env.timeOfDay ?? 0.35;               // 0 = dawn, 0.5 = noon, 1 = dusk
    const elev = Math.sin(t * Math.PI) * 1.05 + 0.08;   // radians-ish
    const az = (t - 0.5) * Math.PI * 1.2 + 0.4;
    const dir = new THREE.Vector3(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).normalize();
    this.sunDir = dir;
    this.sun.position.copy(dir).multiplyScalar(220);
    const warm = 1 - Math.min(1, Math.sin(t * Math.PI) * 1.4);   // low sun -> warm
    this.sun.color.setRGB(1, 0.98 - warm * 0.25, 0.94 - warm * 0.5);
    this.sun.intensity = 2.4 + Math.sin(t * Math.PI) * 1.3;
    this.skyUniforms.sunDir.value.copy(dir);
    const zen = new THREE.Color().setHSL(0.6, 0.62, 0.42 + Math.sin(t * Math.PI) * 0.16);
    const hor = new THREE.Color().lerpColors(new THREE.Color(0xffc9a3), new THREE.Color(0xe3eef9), Math.min(1, Math.sin(t * Math.PI) * 1.6));
    this.skyUniforms.zenith.value.copy(zen); this.skyUniforms.horizon.value.copy(hor);
    this.hemi.intensity = 0.45 + Math.sin(t * Math.PI) * 0.35;
    const f = this.env.fog ?? 0.35;
    this.scene.fog.color.copy(hor).lerp(new THREE.Color(0xffffff), 0.3);
    this.scene.fog.near = 120 - f * 90; this.scene.fog.far = 3200 - f * 1700;
    this.snow.setDensity(this.env.snowfall ?? 0.2);
  }

  // Keep the shadow frustum and the sky centred on the viewer.
  update(dt, viewerPos, camera) {
    this.sunTarget.position.copy(viewerPos);
    this.sun.position.copy(viewerPos).addScaledVector(this.sunDir, 220);
    this.sky.position.copy(camera.position);
    if (this.mountains) this.mountains.position.set(camera.position.x, this.mountains.userData.baseY, camera.position.z);
    this.snow.update(dt, camera.position, this.env.wind ?? 0.2);
  }
}

function makeMountains() {
  // A ring of jagged peaks 1.2 - 2.5 km out, drawn as a cylinder strip with an fbm skyline.
  const segs = 220, rings = 6, R0 = 1200, R1 = 2600;
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  for (let j = 0; j <= rings; j++) {
    const r = R0 + (R1 - R0) * (j / rings);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ridge = 0.5 + 0.5 * fbm(Math.cos(a) * 3.1 + 10, Math.sin(a) * 3.1 + 5, 5, 2.1, 0.55);
      const peakness = Math.pow(ridge, 1.6);
      const y = -60 + peakness * (380 + 380 * (j / rings)) * (0.6 + 0.4 * Math.sin(j * 1.3 + a * 7));
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      const snowy = y > 120 ? 1 : Math.max(0, (y - 20) / 100);
      c.setRGB(0.42 + 0.5 * snowy, 0.47 + 0.47 * snowy, 0.56 + 0.42 * snowy);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
    const a = j * (segs + 1) + i, b = a + 1, d = a + segs + 1, e = d + 1;
    idx.push(a, b, d, b, e, d);
  }
  // fill the floor between the terrain edge and the mountains
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  m.userData.baseY = -40; m.frustumCulled = false; m.name = 'mountains';
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1300, 48), new THREE.MeshStandardMaterial({ color: 0xe9f0f8, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -58; floor.receiveShadow = false;
  m.add(floor);
  return m;
}

function makeSnowfall(count = 1400) {
  const box = 70, half = box / 2;
  const pos = new Float32Array(count * 3), vel = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * box; pos[i * 3 + 1] = (Math.random() - 0.5) * box; pos[i * 3 + 2] = (Math.random() - 0.5) * box;
    vel[i] = 1.2 + Math.random() * 1.6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true });
  const points = new THREE.Points(g, mat); points.frustumCulled = false; points.name = 'snowfall';
  let density = 0.2, t = 0, acc = 0;
  const center = new THREE.Vector3();
  return {
    points,
    setDensity(d) { density = d; points.visible = d > 0.01; g.setDrawRange(0, Math.floor(count * Math.min(1, d))); },
    update(dt, cam, wind) {
      if (!points.visible) return;
      // the flakes are tiny and fast; stepping them at 30 Hz is indistinguishable and halves the cost
      acc += dt; if (acc < 1 / 30) return;
      dt = acc; acc = 0;
      t += dt;
      center.copy(cam);
      const n = Math.floor(count * Math.min(1, density));
      for (let i = 0; i < n; i++) {
        let x = pos[i * 3] - center.x, y = pos[i * 3 + 1] - center.y, z = pos[i * 3 + 2] - center.z;
        y -= vel[i] * dt; x += (Math.sin(t * 0.7 + i) * 0.4 + wind * 2.5) * dt; z += Math.cos(t * 0.5 + i * 0.3) * 0.3 * dt;
        if (y < -half) y += box; if (x > half) x -= box; if (x < -half) x += box; if (z > half) z -= box; if (z < -half) z += box;
        pos[i * 3] = x + center.x; pos[i * 3 + 1] = y + center.y; pos[i * 3 + 2] = z + center.z;
      }
      g.attributes.position.needsUpdate = true;
    },
  };
}
