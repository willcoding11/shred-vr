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
    // ONE WIND, and everything that moves reads it.
    //
    // Nothing in this world was being acted on by anything. The lift chairs went round and a
    // handful of flakes fell, and that was the entire inventory of motion on a mountain -- which
    // is half of why it reads as a photograph of a place rather than a place. The cheapest way
    // out of that is not more effects, it is ONE signal that several things obey at once: the
    // same gust that lifts snow off a crest bends the trees and rises in your ears. Separate
    // wiggles on separate timers read as a screensaver; a shared one reads as weather.
    this.wind = { dirX: 0.93, dirZ: 0.37, gust: 0.5, strength: 0.2, t: 0 };
    this.spindrift = makeSpindrift(); scene.add(this.spindrift.points);
    this.env = {};
    this.setEnv({ timeOfDay: 0.35, fog: 0.35, snowfall: 0.2 });
  }

  // THE WORLD OUTSIDE THE MAP.
  //
  // Built around the map's own footprint, because the ring has to start exactly where the
  // playable ground stops. Called whenever a map is loaded or its shape settles.
  setGround(map) {
    if (!this.mountains || !map) return;
    this._map = map;
    this.scene.remove(this.mountains);
    this.mountains.geometry.dispose();
    this.mountains = makeMountains(map, this.sunDir, this.env.fog ?? 0.35, this.scene.fog?.color);
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
    // Two slow sines beating against each other: no repeat you can hear or see, no noise texture,
    // no state. Real gusts arrive in bursts with lulls between them, which one sine cannot do.
    const wt = (this.wind.t += dt);
    const base = this.env.wind ?? 0.2;
    const g = 0.5 + 0.5 * Math.sin(wt * 0.41) * Math.sin(wt * 0.13 + 1.7);
    this.wind.gust = Math.max(0, Math.min(1, 0.25 + g * 0.9)) * (0.35 + base * 1.3);
    this.wind.strength = base;
    if (this._envDirty) {
      this._envDirty = false;
      this.buildEnvironment();
      // The range carries its sun in its vertex colours, so moving the sun means rebuilding it.
      // Five thousand vertices, once, when the time of day is dragged in the editor.
      if (this._map) this.setGround(this._map);
    }
    this.sunTarget.position.copy(viewerPos);
    this.sun.position.copy(viewerPos).addScaledVector(this.sunDir, 220);
    this.sky.position.copy(camera.position);
    // The far country is a fixed place in the world. It used to be pinned to the camera, so 480 m
    // of descent moved the far peaks not one pixel and the strongest scale cue in the scene was dead.
    this.snow.update(dt, camera.position, this.env.wind ?? 0.2);
    this.spindrift.update(dt, viewerPos, this.wind, this.ground);
  }
}

// The radiance the horizon haze arrives at, which is what a ridge four kilometres out fades
// into. Not an albedo -- nothing lights this.
const _HAZE_RAD = [0.62, 0.70, 0.86];

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
function makeMountains(map, sunDir = null, fogAmt = 0.35, fogColor = null) {
  // 4200 and not further: the map's half-diagonal is about 720 m, so the furthest any camera
  // can be from the outermost shell is 4920 -- just inside the 5000 m far plane, which is as
  // far as it can go without widening the depth range and costing precision on the board.
  const S = 256, K = 18, RMAX = 4200;
  // With no map yet (the editor builds Scenery before it loads one) stand in with a square
  // kilometre; setGround rebuilds this the moment a real one arrives.
  const a = map ? ((map.size.w - 1) * map.spacing) / 2 : 500;
  const b = map ? ((map.size.h - 1) * map.spacing) / 2 : 500;
  const cz = b;
  const pos = [], col = [], idx = [];
  const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

  // The whole range as a function, so it can be asked about points that are not vertices -- which
  // is what casting a shadow across it needs.
  const height = (x, z, r0, eh) => {
    const d = Math.max(0, Math.hypot(x, z - cz) - r0);
    const floor = eh - 22 - 70 * sm(d / 900);
    const grow = Math.pow(sm(d / 2600), 1.25);
    // The floor climbs too, not only the peaks. With a flat base the low ground between the
    // ridges stayed at one height for three kilometres, and from sixty metres up that is a plane
    // seen almost edge-on: it compressed into a pale band across the middle of every wide shot,
    // with its own undulations poking through as dark slivers that read as debris in the sky.
    return floor + 300 * grow + ridged(x * 0.00040 + 40, z * 0.00040 + 11) * (820 * grow);
  };
  // The inner radius and the map's edge height in a given direction, which is all `height` needs
  // to be evaluated anywhere rather than only on the shells.
  const at = (x, z) => {
    const th = Math.atan2(z - cz, x);
    const ct = Math.cos(th), st = Math.sin(th);
    const r0 = Math.min(Math.abs(a / (Math.abs(ct) < 1e-4 ? 1e-4 : ct)),
                        Math.abs(b / (Math.abs(st) < 1e-4 ? 1e-4 : st)));
    return [r0, map ? heightAt(map, ct * r0 * 0.995, cz + st * r0 * 0.995) : 0];
  };

  // A RANGE WITH NO SHADOW ON IT IS A CUT-OUT. Lighting alone gives every face its own tone, but
  // what makes a real skyline read as solid is one ridge throwing shade across the next -- the
  // light side and the dark side of the same massif. Marched here and baked into the vertex
  // colours, so it costs nothing per frame and nothing in the shadow map, which at this distance
  // could never have covered it anyway.
  const sunLit = (x, y, z) => {
    if (!sunDir || sunDir.y <= 0.02) return 1;
    const step = 190, n = 11;
    let shade = 0;
    for (let i = 1; i <= n; i++) {
      const t = i * step;
      const px = x + sunDir.x * t, pz = z + sunDir.z * t;
      const ray = y + sunDir.y * t;
      const [r0, eh] = at(px, pz);
      const h = height(px, pz, r0, eh);
      if (h > ray) shade = Math.max(shade, Math.min(1, (h - ray) / 120));
    }
    return 1 - shade * 0.82;
  };

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
      // Down into a valley first, and only then up, because a mountain you are standing on is
      // higher than what is immediately around it -- skipping that step is what made the old ring
      // look like a wall around a garden.
      //
      // BUT SHALLOW. The first try dug 268 m of trench starting at the map boundary and put a
      // 980 m peak at only 1.7 km, which from a metre off the snow means you look straight ACROSS
      // the trench: the connecting ground is below the sight line, so the range rose out of
      // nothing with sky underneath it and hung off the top of the frame. A 92 m fall over 900 m
      // stays in view the whole way, and the peaks are further out and lower, so the ground runs
      // unbroken from your feet to the skyline the way it does in every photograph of a mountain.
      const floor = eh - 22 - 70 * sm(d / 900);
      const grow = Math.pow(sm(d / 2600), 1.25);
      // The floor climbs too, not only the peaks. With a flat base the low ground between the
      // ridges stayed at one height for three kilometres, and from sixty metres up that is a
      // plane seen almost edge-on: it compressed into a pale band across the middle of every
      // wide shot, with its own small undulations poking through as dark slivers that read as
      // debris floating in the sky. Ground that rises the whole way out is a massif rather than
      // peaks standing on a plain, and there is no near-edge-on surface left to alias.
      const y = height(x, z, r0, eh);
      pos.push(x, y, z);
      col.push(0, 0, 0);      // filled once the normals exist
    }
  }
  // NO OVERHANGS. The shells grow outward, so the outermost quads are four hundred metres deep
  // by a hundred wide, and ridged noise across a gap that long can drop faster than the quad is
  // wide -- which draws as a near-vertical sliver seen edge-on, the dark splinters that were
  // lying across the range. Walking outward and limiting how fast the ground may fall or climb
  // between shells removes them without touching the silhouette.
  for (let i = 0; i <= S; i++) {
    for (let k = 1; k <= K; k++) {
      const a = (k - 1) * (S + 1) + i, b = k * (S + 1) + i;
      const dr = Math.hypot(pos[b * 3] - pos[a * 3], pos[b * 3 + 2] - pos[a * 3 + 2]);
      const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
      const lim = dr * 1.1;
      if (dy > lim) pos[b * 3 + 1] = pos[a * 3 + 1] + lim;
      else if (dy < -lim) pos[b * 3 + 1] = pos[a * 3 + 1] - lim;
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

  // LIT HERE, NOT BY THE RENDERER.
  //
  // This was a MeshStandardMaterial with the aerial perspective mixed into its vertex colours,
  // which is the wrong way round and quietly undid the whole effect: haze is something that
  // happens to light on its way to your eye, so folding it into the ALBEDO means the renderer
  // then multiplies the haze by the lighting -- a ridge in shadow got dark haze, a ridge in sun
  // got bright haze, and the distance cue cancelled itself out. Every shadow marched into these
  // vertices came out compressed to nothing for the same reason.
  //
  // So the sun, the sky and the shadow are resolved here, into radiance, and the material is
  // unlit. It is more control, not less: the range is a backdrop three to four kilometres away
  // and nothing about it needs to respond to anything at runtime. It is also cheaper -- no
  // lighting, no normals in the shader, one flat pass over 9,200 triangles.
  const nrm = g.attributes.normal;
  const lowest = map ? lowestOf(map) : -200;
  const SKY = [0.17, 0.20, 0.27];     // the blue dome, which is all a shaded face gets
  const HAZE_MAX = Math.min(0.94, 0.22 + fogAmt * 0.85);
  // Into the weather's own colour, or the range fades toward a blue that the near ground is not
  // fading toward and the two disagree about what the air is doing.
  const HAZE = fogColor ? [fogColor.r, fogColor.g, fogColor.b] : _HAZE_RAD;
  for (let v = 0; v < pos.length / 3; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const nx = nrm.getX(v), ny = nrm.getY(v), nz = nrm.getZ(v);
    const slope = Math.acos(Math.min(1, Math.max(-1, ny))) * 57.2958;
    // ROCK IN BANDS, not by slope alone. Smooth-shaded ridged noise almost never exceeds a 33
    // degree threshold, so a slope rule alone resolved nearly the whole range to snow and four
    // kilometres of mountain came out one flat pale grey -- the same failure as corduroy
    // everywhere: no contrast, no distance, no mountain. A second noise field at about 600 m
    // picks out the faces that are scoured and broken, and the steep parts join in.
    const high = sm((y - (lowest + 260)) / 520);
    const band = sm((ridged(x * 0.0016 + 7, z * 0.0016 + 3, 3) - 0.38) / 0.22);
    const snowy = high * (1 - Math.min(1, band + sm((slope - 28) / 18)));
    const rock = 1 - snowy;
    // Warmer and darker than the haze it sits in, or it dissolves into its own aerial perspective.
    const shade = 0.15 + 0.10 * (((Math.sin(x * 0.021 + z * 0.013) * 4375.5) % 1 + 1) % 1);
    const alb = [
      shade * 1.14 * rock + 0.94 * snowy,
      shade * 1.00 * rock + 0.96 * snowy,
      shade * 0.88 * rock + 1.00 * snowy,
    ];
    // WRAPPED, not clamped. A true Lambert term takes every face that is turned away from the sun
    // to exactly zero, and on a backlit range that is every face you can see -- which is how the
    // whole thing came out as one flat grey silhouette with all the shadow marching in it
    // invisible. Wrapping the term keeps the gradation across faces that are all, strictly, in
    // shade, which is also closer to what a big hazy airmass actually does to light.
    const raw = sunDir ? nx * sunDir.x + ny * sunDir.y + nz * sunDir.z : 0.2;
    const ndl = Math.max(0, (raw + 0.35) / 1.35);
    const lit = sunLit(x, y, z);
    const sun = 0.92 * ndl * lit;
    const skyView = 0.55 + 0.45 * Math.max(0, ny);   // a face looking up sees more of the dome
    const d = Math.hypot(x, z - cz);
    // Aerial perspective, applied to the light rather than to the paint, and capped well short of
    // the sky's own value: a ridge that reaches it is a ridge you cannot see.
    // Enough to say "far away", not enough to erase what is out there -- and tied to the map's own
    // weather, because this mesh is deliberately not fogged by the scene and on the storm map that
    // meant a crisp skyline four kilometres away behind a hundred metres of white-out. The number
    // it reaches on a clear day is deliberately low: alpine air is very clear, and at two thirds
    // haze every difference between rock and snow and between a lit face and a shaded one was
    // compressed into a grey band, which is the cut-out this was built to stop.
    const h = Math.min(HAZE_MAX, sm((d - 700) / 3000) * (HAZE_MAX * 1.15));
    for (let k = 0; k < 3; k++) {
      const rad = alb[k] * (sun + SKY[k] * skyView);
      col[v * 3 + k] = rad * (1 - h) + HAZE[k] * h;
    }
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));

  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
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

// A round, soft point. Without one, a PointsMaterial draws literal squares -- and a snowflake
// two metres from your eye is then a white tile hanging in the sky, which is exactly what was in
// every screenshot with snowfall turned on. One 32-pixel texture shared by every particle in the
// scene.
let _dot = null;
function softDot() {
  if (_dot) return _dot;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.82)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  _dot = new THREE.CanvasTexture(c);
  _dot.colorSpace = THREE.SRGBColorSpace;
  return _dot;
}

// SPINDRIFT: snow the wind has picked up off the ground and is carrying.
//
// The thing every photograph of a windy ridge has in it and this had nothing of. It is also the
// one moving thing that reads at DISTANCE -- a tree swaying is invisible past thirty metres in a
// headset, but a plume tearing off a crest half a kilometre away is the whole story of the
// weather, and it happens up on the skyline where this world's frame is emptiest.
//
// Built like the snowfall: one Points, one draw call, a fixed pool recycled through a box that
// follows the viewer. The difference is that these hug the ground -- each one is re-seated onto
// the terrain every step -- so they read as snow being dragged across a surface rather than snow
// falling through the air.
function makeSpindrift(count = 700) {
  const BOX = 120, half = BOX / 2;
  const pos = new Float32Array(count * 3);
  const life = new Float32Array(count), speed = new Float32Array(count), lift = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * BOX;
    pos[i * 3 + 1] = 0;
    pos[i * 3 + 2] = (Math.random() - 0.5) * BOX;
    life[i] = Math.random();
    speed[i] = 5 + Math.random() * 11;
    lift[i] = 0.15 + Math.random() * 2.2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xf2f7ff, size: 0.15, map: softDot(), transparent: true, opacity: 0.5,
    depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false; points.name = 'spindrift';
  let acc = 0;
  const c = new THREE.Vector3();
  return {
    points,
    update(dt, viewer, wind, ground) {
      const amount = Math.min(1, wind.strength * 1.9);
      points.visible = amount > 0.06 && !!ground;
      if (!points.visible || !viewer) return;
      acc += dt; if (acc < 1 / 30) return;
      dt = acc; acc = 0;
      const n = Math.floor(count * amount);
      g.setDrawRange(0, n);
      mat.opacity = 0.22 + wind.gust * 0.42;
      c.copy(viewer);
      const vx = wind.dirX * (0.4 + wind.gust), vz = wind.dirZ * (0.4 + wind.gust);
      for (let i = 0; i < n; i++) {
        let x = pos[i * 3] + vx * speed[i] * dt;
        let z = pos[i * 3 + 2] + vz * speed[i] * dt;
        // Recycle across the box in world space, then re-seat onto whatever ground is there.
        // Rounded rather than a single wrap either way, so the pool still lands around the viewer
        // when the viewer has jumped -- which is what the reset does, and what the screenshot
        // harness does eight times a map.
        x -= Math.round((x - c.x) / BOX) * BOX;
        z -= Math.round((z - c.z) / BOX) * BOX;
        life[i] += dt * 0.55;
        if (life[i] > 1) life[i] -= 1;
        // Up off the surface and back down again: a grain of snow gets picked up, carried, and
        // dropped, and the plume is the envelope of thousands of those.
        const h = Math.sin(life[i] * Math.PI) * lift[i] * (0.35 + wind.gust);
        pos[i * 3] = x; pos[i * 3 + 2] = z;
        pos[i * 3 + 1] = ground(x, z) + 0.05 + h;
      }
      g.attributes.position.needsUpdate = true;
    },
  };
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
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.13, map: softDot(), transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true });
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
