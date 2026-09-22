// Sky, sun, distant peaks, fog and falling snow. Shared by game + editor.
import * as THREE from 'three';
import { realSkyVert, realSkyFrag } from './realism.js';
import { fbm, heightAt } from './mapformat.js';
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
    // 2048 and 1024, not 4096 and 2048. A 4096 square depth buffer is sixteen megapixels of
    // shadow pass every frame, which on a standalone headset is a straight tax on everything else
    // -- and it was only that big because the map had to cover distance. It does not any more:
    // the sun shadowing over the whole mountain is baked into the terrain's vertex colours, so
    // this map now only has to do the near field, and a tighter frustum at half the resolution is
    // sharper there than the big one ever was.
    shadowSize ??= quality === 'real' ? 2048 : 1024;
    this.scene = scene;
    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      const c = this.sun.shadow.camera;
      // a tighter frustum around the rider: ~7 cm/texel at 2048 instead of ~10 cm
      // Wider than the rider needs, because a 25 degree sun throws shadows two to three times
      // the height of whatever casts them, and the hill is now casting its own.
      // 70 m rather than 110: at 2048 that is 6.8 cm a texel, finer than the old 110 m box at
      // 4096 managed, and the wide shadows it used to be stretched to cover are baked now.
      c.left = -70; c.right = 70; c.top = 70; c.bottom = -70; c.near = 1; c.far = 420;
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
      turbidity: { value: 2.0 }, exposure: { value: 1.06 }, cloud: { value: 0.45 }, time: { value: 0 },   // 1.25 clipped the horizon to white
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
    this.wantMountains = mountains;
    if (mountains) scene.add(this.mountains = makeMountains(null));
    this.snow = makeSnowfall(); scene.add(this.snow.points);
    this.env = {};
    this.setEnv({ timeOfDay: 0.35, fog: 0.35, snowfall: 0.2 });
  }

  // THE WORLD OUTSIDE THE MAP.
  //
  // Built around the map's own footprint, because the ring has to start exactly where the
  // playable ground stops. Called whenever a map is loaded or its shape settles.
  setGround(map) {
    if (!this.mountains || !map) return;
    this.scene.remove(this.mountains);
    this.mountains.geometry.dispose();
    this.mountains = makeMountains(map);
    this.scene.add(this.mountains);
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
    if (this.sun.shadow) { this.sun.shadow.mapSize.set(real ? 2048 : 1024, real ? 2048 : 1024); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
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
    // FILL, NOT A SECOND SUN. At 0.45 to 0.80 the hemisphere was lifting the shaded side of
    // every roller, gully wall and tree back to nearly the lit value, and a slope with no shaded
    // side is exactly the white bedsheet the mountain was reading as. Snow in shade is darker AND
    // bluer, and on Real the sky cubemap is already doing the blue properly, so the hemisphere
    // only has to fill what the cubemap misses. Fast has no cubemap and keeps more of it.
    const fill = this.quality === 'real' ? 0.20 : 0.34;
    this.hemi.intensity = fill + Math.sin(t * Math.PI) * fill * 0.55;
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
    // The far country is a fixed place in the world. It used to be pinned to the camera, so 480 m
    // of descent moved the far peaks not one pixel and the strongest scale cue in the scene was dead.
    this.snow.update(dt, camera.position, this.env.wind ?? 0.2);
  }
}

const _HAZE = new THREE.Color(0.58, 0.67, 0.83);

// Ridged noise: fbm folded about zero and sharpened, which is what turns rounded hills into
// aretes. Real ridgelines are creases where two faces meet, and ordinary fbm cannot make a crease.
// FOUR OCTAVES, NOT FIVE, AND A LONGER BASE WAVELENGTH -- because the shells grow outward and the
// outermost one samples the ring every 90 m. A fifth octave puts 73 m detail into a 90 m sample
// spacing, and undersampled ridged noise does not look rough, it looks like white shards thrown
// into the sky. The finest octave here is a 280 m wavelength, which the outer shells can hold.
function ridged(x, z, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(fbm(x * f, z * f, 1, 2, 0.5) * 2 - 1);
    v += n * n * amp;
    amp *= 0.52; f *= 2.07;
  }
  return Math.min(1, v * 1.15);
}

// ---------------------------------------------------------------- the far country
//
// WHAT WAS THERE BEFORE WAS A CUT-OUT ON A PLATE.
//
// A cylinder strip of flat-shaded peaks standing 1.2 km out, with a 2.6 km disc of untextured
// white underneath it to cover the gap. From anywhere high on the hill you could see the disc's
// circular rim, the peaks read as folded paper because flat shading on a skyline with one value
// per face has no way not to, and between the edge of the map and that ring there was nothing at
// all -- no foothills, no shoulders, no receding ridges. Which is why the mountain had no
// distance in it, and distance is most of what a mountain picture is.
//
// This is a real heightfield instead, and it starts exactly where the map stops. Polar around
// the map centre, but with the inner radius following the map's own rectangle, so a run that is
// 220 m wide and a kilometre long gets country hugging both of its long sides rather than a
// circle inscribed somewhere beyond the corners. Fourteen shells with the spacing growing
// outward: dense where you can see detail, coarse where you cannot.
//
// 7,000 triangles in one draw call, against 2,600 for the strip plus a disc in two.
function makeMountains(map) {
  const S = 256, K = 18, RMAX = 3200;
  // With no map yet (the editor builds Scenery before it loads one) stand in with a square
  // kilometre; setGround rebuilds this the moment a real one arrives.
  const a = map ? ((map.size.w - 1) * map.spacing) / 2 : 500;
  const b = map ? ((map.size.h - 1) * map.spacing) / 2 : 500;
  const cz = b;
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

  for (let k = 0; k <= K; k++) {
    // Growth, not even spacing: the first shells are metres apart and the last are hundreds, so
    // the silhouette stays smooth where it is 3 km away and the shoulder just past the map edge
    // still has enough vertices to be a shoulder.
    // 1.55 rather than 1.75, over eighteen shells rather than fourteen. Too much growth and the
    // outermost quads are five hundred metres deep by ninety wide, which the ridged noise then
    // folds into near-vertical slivers you see edge-on as dark splinters lying across the range.
    const t = Math.pow(k / K, 1.55);
    for (let i = 0; i <= S; i++) {
      const th = (i / S) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      // Where the map's own rectangle ends in this direction.
      const r0 = Math.min(Math.abs(a / (Math.abs(ct) < 1e-4 ? 1e-4 : ct)),
                          Math.abs(b / (Math.abs(st) < 1e-4 ? 1e-4 : st)));
      const r = r0 + (RMAX - r0) * t;
      const x = ct * r, z = cz + st * r;
      // The map's height where the ring meets it, so the two never disagree about where the
      // ground is. Sampled a hair inside so it is a real reading rather than a clamp.
      const eh = map ? heightAt(map, ct * r0 * 0.995, cz + st * r0 * 0.995) : 0;
      const d = r - r0;
      // Down into a valley first, and only then up. A mountain you are standing on is higher than
      // what is immediately around it, and skipping that step is what made the old ring look like
      // a wall around a garden.
      const floor = eh - 58 - 210 * sm(d / 520);
      const grow = Math.pow(sm(d / 1700), 1.15);
      const y = floor + ridged(x * 0.00040 + 40, z * 0.00040 + 11) * (980 * grow);
      pos.push(x, y, z);
      col.push(0, 0, 0);      // filled once the normals exist
    }
  }
  for (let k = 0; k < K; k++) for (let i = 0; i < S; i++) {
    const p0 = k * (S + 1) + i, p1 = p0 + 1, p2 = p0 + S + 1, p3 = p2 + 1;
    idx.push(p0, p2, p1, p1, p2, p3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();          // smooth, not flat: a 3 km ridge is not made of facets

  // Colour after the normals, because what is rock and what is snow is a question about slope.
  const nrm = g.attributes.normal;
  const lowest = map ? lowestOf(map) : -200;
  for (let v = 0; v < pos.length / 3; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const slope = Math.acos(Math.min(1, Math.max(-1, nrm.getY(v)))) * 57.2958;
    // Snow above the line and off the steep faces -- the same rule the playable hill uses, so
    // the far country and the near ground agree about what a mountain is made of.
    // A snow line, and it has to be high enough that there is rock under it. Everything white
    // is the same failure as everything groomed: no contrast, no distance, no mountain.
    const high = sm((y - (lowest + 40)) / 460);
    const snowy = high * (1 - sm((slope - 33) / 20));
    const rock = 1 - snowy;
    const shade = 0.30 + 0.13 * (((Math.sin(x * 0.021 + z * 0.013) * 4375.5) % 1 + 1) % 1);
    c.setRGB(shade * 1.05 * rock + 0.93 * snowy, shade * rock + 0.95 * snowy, shade * 0.98 * rock + 1.0 * snowy);
    // Aerial perspective, and it has to be strong. Contrast falling off with distance is the
    // single cue that tells you a ridge is four kilometres away rather than four hundred metres.
    const d = Math.hypot(x, z - cz);
    // Capped well short of one: a ridge that reaches the sky's own value is a ridge you
    // cannot see, and the sky is nearly white at the horizon.
    c.lerp(_HAZE, Math.min(0.62, sm((d - 400) / 2400) * 0.68));
    col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));

  // NOT FOGGED BY THE SCENE. The scene's fog reaches white by four kilometres, which is where
  // this thing lives, so the range was arriving at very nearly the colour of the sky and what you
  // saw was the handful of peaks that happened to poke above the haze band -- pale shards
  // floating over a white gap, with the ridges that joined them invisible. It carries its own
  // aerial perspective in the vertex colours instead, which is the same effect under control:
  // strong enough that four kilometres reads as four kilometres, capped short of the sky's value
  // so a ridge always stays a ridge.
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, fog: false }));
  m.frustumCulled = false; m.name = 'mountains';
  m.userData.baseY = 0; m.userData.pinned = false;
  return m;
}

function lowestOf(map) {
  let lo = Infinity;
  const H = map.heights;
  for (let i = 0; i < H.length; i += 7) if (H[i] < lo) lo = H[i];
  return lo === Infinity ? -200 : lo;
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
