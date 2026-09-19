// Sky, sun, distant peaks, fog and falling snow. Shared by game + editor.
import * as THREE from 'three';
import { realSkyVert, realSkyFrag } from './realism.js';
import { fbm } from './mapformat.js';
import { makeSnowTexture } from './terrain.js';

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
  constructor(scene, { shadows = true, shadowSize = null, mountains = true, quality = 'fast', renderer = null } = {}) {
    this.quality = quality; this.renderer = renderer;
    // Derived from the quality, not defaulted to Fast's. setQuality early-returns when the quality
    // has not CHANGED, and the game constructs Scenery already set to 'real' -- so the 4096 bump
    // in there never ran and the Real preset quietly loaded with a 2048 map. You could only get
    // the intended one by toggling the dropdown to Fast and back again.
    shadowSize ??= quality === 'real' ? 4096 : 2048;
    this.scene = scene;
    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      const c = this.sun.shadow.camera;
      // a tighter frustum around the rider: ~7 cm/texel at 2048 instead of ~10 cm
      // Wider than the rider needs, because a 25 degree sun throws shadows two to three times
      // the height of whatever casts them, and the hill is now casting its own.
      c.left = -110; c.right = 110; c.top = 110; c.bottom = -110; c.near = 1; c.far = 600;
      // 0.6 m of normal bias is eleven texels at this resolution and frustum, which is why
      // shadows were detaching from tree trunks and lift towers and floating beside them.
      this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.08;
    }
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sun, this.sunTarget); this.sun.target = this.sunTarget;
    this.hemi = new THREE.HemisphereLight(0x9ec4ff, 0xb9c6d6, 0.38);
    scene.add(this.hemi);

    const real = quality === 'real';
    this.skyUniforms = {
      zenith: { value: new THREE.Color(0x3d7dd8) }, horizon: { value: new THREE.Color(0xdbe8f7) },
      sunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2).normalize() }, sunColor: { value: new THREE.Color(0xfff2d0) },
      sunSize: { value: 1.0 },
      turbidity: { value: 2.0 }, exposure: { value: 1.25 }, cloud: { value: 0.45 }, time: { value: 0 },
    };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(4000, real ? 64 : 32, real ? 32 : 16), new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: real ? realSkyVert : skyVert,
      fragmentShader: real ? realSkyFrag : skyFrag,
      side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    this.sky.renderOrder = -10; this.sky.frustumCulled = false;
    scene.add(this.sky);

    scene.fog = new THREE.Fog(0xdbe8f7, 200, 1400);
    if (mountains) scene.add(this.mountains = makeMountains());
    this.snow = makeSnowfall(); scene.add(this.snow.points);
    this.env = {};
    this.setEnv({ timeOfDay: 0.35, fog: 0.35, snowfall: 0.2 });
  }

  // Drop the distant valley floor below the map. It is a 2.6 km disc that fills the gap between
  // the terrain edge and the mountains, it rides along with the camera, and it used to sit at a
  // fixed world height of -98 m. The runs descend 116 to 365 m, so on two of the three maps it
  // sliced straight through the hill: stand at the top, and a hard white plane cut off everything
  // below it. It has to live under the lowest point of whatever map is loaded.
  // Also where the map IS. The ring used to be re-centred on the camera every frame, which hid
  // the fact that it is built around its own origin; standing it still without also moving it to
  // the middle of the map left it centred on the map's north edge, so half of it sat behind the
  // mountain and the other half was a kilometre too far away.
  setGround(lowestY, cx = 0, cz = 0) {
    if (!this.mountains) return;
    this.mountains.position.set(cx, this.mountains.userData.baseY, cz);
    const floor = this.mountains.userData.floor;
    if (floor) floor.position.y = lowestY - 12 - this.mountains.userData.baseY;
  }

  // Swap the look without tearing the scene down. Only the sky material and the shadow
  // resolution actually differ; the terrain and props are rebuilt by the caller.
  // IMAGE-BASED LIGHTING, from the sky we already have. This is the single biggest thing the
  // scene was missing: snow shadows are blue because they are lit by a blue dome, not because
  // something tinted them, and nothing in the scene -- not the board, not the steel edge, not
  // the lift cable, not a window -- had anything at all to reflect. One cubemap render per
  // lighting change, not per frame.
  buildEnvironment() {
    if (!this.renderer || this.quality !== 'real') {
      if (this.scene.environment) { this.scene.environment = null; }
      return;
    }
    if (!this._pmrem) {
      this._pmrem = new THREE.PMREMGenerator(this.renderer);
      this._envScene = new THREE.Scene();
      this._envScene.add(new THREE.Mesh(this.sky.geometry, this.sky.material));
    }
    this._envRT?.dispose();
    this._envRT = this._pmrem.fromScene(this._envScene, 0, 1, 6000);
    this.scene.environment = this._envRT.texture;
    this.scene.environmentIntensity = 0.55;
  }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    const real = q === 'real';
    this.sky.material.vertexShader = real ? realSkyVert : skyVert;
    this.sky.material.fragmentShader = real ? realSkyFrag : skyFrag;
    this.sky.material.needsUpdate = true;
    if (this.sun.shadow) { this.sun.shadow.mapSize.set(real ? 4096 : 2048, real ? 4096 : 2048); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
    this.setEnv({});
    this.buildEnvironment();
  }

  setEnv(env) {
    const before = this.env.timeOfDay;
    this.env = { ...this.env, ...env };
    // weather and time of day have to actually reach the sky
    this.skyUniforms.cloud.value = 0.18 + (this.env.fog ?? 0.35) * 0.9;
    this.skyUniforms.turbidity.value = 1.7 + (this.env.fog ?? 0.35) * 1.9;
    if (before !== this.env.timeOfDay) this._envDirty = true;
    const t = this.env.timeOfDay ?? 0.35;               // 0 = dawn, 0.5 = noon, 1 = dusk
    // A WINTER sun: low. The old curve put it 58 degrees up at midday, which is a July noon --
    // it lights every face equally, no roller casts a shadow, and the hill reads as a flat white
    // sheet. At a ski latitude the winter sun peaks around 20-25 degrees, and that raking light
    // is the single biggest thing that makes snow legible.
    const elev = Math.sin(t * Math.PI) * 0.50 + 0.07;   // radians: ~28 deg at midday, 4 at dawn
    // Azimuth, and it matters more than it looks. At +0.4 the sun sat almost straight down the
    // valley, which is the one direction that lights every face of a mountain equally: measured
    // over the whole heightfield, the most sun-averted face on the map was dot(N, sun) = -0.11, so
    // there was no terminator anywhere on it at any time of day. Swung round to rake across the
    // fall line instead, every spur, gully wall and roller has a lit side and a shaded one, which
    // is most of why a photograph of snow reads as landscape rather than as a bedsheet.
    //
    // It is easy to overshoot this. At -1.15 the sun ended up BEHIND the summit: the whole
    // mountain was backlit, the baked shadow covered 56% of the map and the hill went a flat
    // grey. -0.23 puts it about 65 degrees off the fall line at the times of day the maps use --
    // raking across the faces, still in front of them.
    const az = (t - 0.5) * Math.PI * 1.2 - 0.23;
    const dir = new THREE.Vector3(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).normalize();
    this.sunDir = dir;
    this.sun.position.copy(dir).multiplyScalar(220);
    const warm = 1 - Math.min(1, Math.sin(t * Math.PI) * 1.05);  // low sun -> warm
    this.sun.color.setRGB(1, 0.98 - warm * 0.25, 0.94 - warm * 0.5);
    this.sun.intensity = 2.5 + Math.sin(t * Math.PI) * 1.5;
    this.skyUniforms.sunDir.value.copy(dir);
    const zen = new THREE.Color().setHSL(0.6, 0.62, 0.42 + Math.sin(t * Math.PI) * 0.16);
    const hor = new THREE.Color().lerpColors(new THREE.Color(0xffc9a3), new THREE.Color(0xe3eef9), Math.min(1, Math.sin(t * Math.PI) * 1.6));
    this.skyUniforms.zenith.value.copy(zen); this.skyUniforms.horizon.value.copy(hor);
    this.hemi.intensity = 0.45 + Math.sin(t * Math.PI) * 0.35;
    const f = this.env.fog ?? 0.35;
    this.scene.fog.color.copy(hor).lerp(new THREE.Color(0xffffff), 0.3);
    // Aerial perspective, not a white-out. Starting the haze at 100 m made a kilometre-wide
    // mountain fade to nothing barely past the trees in front of you, which reads as fog rolling
    // in rather than as distance. Real mountain air is very clear; you want the far peaks
    // softened and nothing else.
    // Aerial perspective is a DEPTH CUE, not a defect: pushing the haze further out on the Real
    // preset made the far ridge the same contrast as the snow twenty metres away, which is the
    // most video-gamey thing a mountain can do. Same distances either way, and the colour is
    // taken from the sky's own horizon so the haze is warm toward the sun.
    this.scene.fog.near = 330 - f * 170; this.scene.fog.far = 4200 - f * 1400;
    this.snow.setDensity(this.env.snowfall ?? 0.2);
  }

  // Keep the shadow frustum and the sky centred on the viewer.
  update(dt, viewerPos, camera) {
    this.skyUniforms.time.value += dt;
    if (this._envDirty) { this._envDirty = false; this.buildEnvironment(); }
    this.sunTarget.position.copy(viewerPos);
    this.sun.position.copy(viewerPos).addScaledVector(this.sunDir, 220);
    this.sky.position.copy(camera.position);
    // The ring used to be pinned to the camera every frame, so 480 m of descent moved the far
    // peaks not one pixel and the strongest scale cue in the scene was dead. The map is a kilometre
    // across and the ring starts at 1.2 km, so letting it stand still costs nothing and buys the
    // parallax back.
    if (this.mountains?.userData.pinned) this.mountains.position.set(camera.position.x, this.mountains.userData.baseY, camera.position.z);
    this.snow.update(dt, camera.position, this.env.wind ?? 0.2);
  }
}

const _HAZE = new THREE.Color(0.72, 0.79, 0.90);
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
      // Coloured by STEEPNESS as well as height, so rock bands show on the faces too steep to
      // hold snow, and washed toward the sky with distance. One snowline test gave every peak a
      // single flat value and the whole ring read as folded paper.
      const steep = Math.min(1, Math.abs(Math.sin(a * 11.0 + j * 2.3)) * 0.45 + peakness * 0.5);
      const snowy = Math.max(0, Math.min(1, (y - 20) / 110)) * (1 - steep * 0.72);
      const rock = 1 - snowy;
      c.setRGB(0.34 * rock + 0.92 * snowy, 0.35 * rock + 0.95 * snowy, 0.41 * rock + 1.0 * snowy);
      c.lerp(_HAZE, Math.min(0.64, ((r - R0) / (R1 - R0)) * 0.55 + 0.08));
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
  m.userData.baseY = -40; m.userData.pinned = false; m.frustumCulled = false; m.name = 'mountains';
  // The valley floor. A flat untextured disc at one value is a dead giveaway at any distance,
  // and it is a big part of frame from anywhere high on the hill.
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xe9f0f8, roughness: 0.95 });
  floorMat.map = makeSnowTexture(256); floorMat.map.repeat.set(160, 160);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1300, 64), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -58; floor.receiveShadow = false;
  floor.name = 'valleyFloor';
  m.add(floor);
  m.userData.floor = floor;
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
