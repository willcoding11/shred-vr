// The "Real" look. Everything in here is appearance only -- nothing it does can be felt through
// the board, and the physics never reads any of it.
//
// A note on what is and is not possible here, because the word that usually comes up is "RTX":
// this runs in WebGL 2 in a browser, on a standalone headset. There is no ray tracing available
// and there is not going to be. What actually moves the needle on snow is different anyway:
// snow is a bright, rough, forward-scattering surface under a very blue sky, and the three
// things that make it read as real are the SKY it is lit by, the way light bounces around
// INSIDE it, and the glitter of individual crystals. Those are what this file does.
import * as THREE from 'three';

// ---------------------------------------------------------------- sky
// Single-scattering Rayleigh + Mie, which is what gives you a sky that is deep blue overhead,
// pale at the horizon, warm around the sun and warmer still when the sun is low -- all of it
// falling out of the physics instead of being three colours dialled in by hand.
export const realSkyVert = `
varying vec3 vDir;
varying vec3 vWorld;
void main(){
  vWorld = (modelMatrix * vec4(position,1.0)).xyz;
  vDir = normalize(vWorld - cameraPosition);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
}`;

export const realSkyFrag = `
uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunSize;
uniform float turbidity; uniform float exposure; uniform float cloud; uniform float time;
varying vec3 vDir;
varying vec3 vWorld;

float miePhase(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main(){
  // Normalise HERE, not in the vertex shader. Interpolating a per-vertex normalised direction
  // across a 64x32 sphere turns the sun into a faceted vertical capsule.
  vec3 d = normalize(vWorld - cameraPosition);
  float h = clamp(d.y, -0.15, 1.0);
  float elev = clamp(sunDir.y, -0.1, 1.0);          // how high the sun is, 0 at the horizon
  float day = smoothstep(-0.02, 0.32, elev);        // 0 at dawn, 1 in the middle of the day

  // The gradient. A physically derived sky is the honest way to do this and I tried it; the
  // single-scattering form is very sensitive to how you scale the optical depths and it went
  // olive before it went blue. This is the same shape the physics produces -- deep and saturated
  // overhead, pale and dusty at the horizon, warm on the sun's side and warmer the lower it is --
  // reached by interpolation between measured-looking endpoints, which cannot go wrong.
  vec3 zenithDay  = vec3(0.115, 0.310, 0.680);
  vec3 zenithDusk = vec3(0.105, 0.150, 0.360);
  vec3 horizDay   = vec3(0.640, 0.760, 0.920);
  vec3 horizDusk  = vec3(0.960, 0.620, 0.380);
  vec3 zen = mix(zenithDusk, zenithDay, day);
  vec3 hor = mix(horizDusk, horizDay, day);
  // Turbidity washes the whole thing out toward white, which is exactly what haze does.
  float haze = clamp((turbidity - 1.6) * 0.30, 0.0, 0.5);
  zen = mix(zen, vec3(0.70, 0.78, 0.88), haze * 0.6);
  hor = mix(hor, vec3(0.86, 0.89, 0.93), haze);

  float t = pow(1.0 - max(h, 0.0), 3.4);
  vec3 col = mix(zen, hor, t);

  float c = dot(d, sunDir);
  // Mie forward-scatter: the bright disc of sky around the sun, which widens as it drops.
  float mie = miePhase(c, 0.76 - 0.12 * (1.0 - day));
  vec3 warm = mix(vec3(1.0, 0.58, 0.30), vec3(1.0, 0.94, 0.84), day);
  col += warm * mie * (0.55 + 1.4 * (1.0 - day)) * (0.35 + 0.65 * t);
  col += warm * pow(max(c, 0.0), 8.0) * 0.10;

  // the sun itself
  float ang = acos(clamp(c, -1.0, 1.0));
  float disc = 1.0 - smoothstep(0.0043 * sunSize, 0.0058 * sunSize, ang);
  float glow = exp(-ang * 19.0) * 0.30 + exp(-ang * 3.2) * 0.05;
  // The disc stays well clear of the halo so the tone curve does not fuse them into one blob.
  col += sunColor * (disc * 5.2 + glow) * (0.35 + 0.65 * day);

  // a thin high cloud deck, drifting
  if (cloud > 0.001 && d.y > 0.015) {
    // Project onto a dome rather than an infinite plane. Dividing by d.y collapses the domain
    // to a speck at the zenith, which is why there was never any cloud overhead.
    vec2 uv = normalize(vec2(d.x, d.z)) * (1.0 - d.y * 0.72) * 2.3 + vec2(time * 0.0045, time * 0.0026);
    float n = fbm(uv * 1.35);
    float cover = smoothstep(0.62 - cloud * 0.34, 0.86, n) * smoothstep(0.015, 0.16, d.y);
    // lit from the sun's side, shaded away from it
    float side = clamp(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))) * 0.5 + 0.5, 0.0, 1.0);
    vec3 lit = mix(vec3(0.58, 0.62, 0.70), mix(vec3(1.0, 0.80, 0.62), vec3(1.0, 0.99, 0.97), day), side);
    col = mix(col, lit, cover * 0.80);
  }

  // haze band at the horizon so it does not end in a line
  col = mix(col, mix(vec3(0.80, 0.68, 0.58), vec3(0.84, 0.88, 0.93), day), smoothstep(0.16, -0.14, d.y) * 0.88);

  col *= exposure;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

// ---------------------------------------------------------------- snow
// Value noise on a lattice that WRAPS.
//
// This map repeats every 1.33 m on the ground, and a noise that does not tile puts a seam there
// that you cannot stop seeing once you have seen it. Wrapping the lattice indices at the octave's
// own period makes the result exactly periodic, so every octave tiles and so does their sum.
function tiling(size, cellsX, cellsY, seed) {
  const out = new Float32Array(size * size);
  const hash = (ix, iy) => {
    const x = ((ix % cellsX) + cellsX) % cellsX, y = ((iy % cellsY) + cellsY) % cellsY;
    return ((Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453) % 1 + 1) % 1;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x / size) * cellsX, fy = (y / size) * cellsY;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = sm(fx - ix), ty = sm(fy - iy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    out[y * size + x] = top + (bot - top) * ty;
  }
  return out;
}

// A micro-relief normal map. Snow is never geometrically flat: it has wind texture, the tracks of
// everything that has been over it, and crystal facets, and at a grazing sun all of that is what
// you are actually looking at.
//
// IT IS NOT A SINE WAVE AND IT IS NOT STATIC. The old one was one ripple at one frequency plus
// Math.random() per texel, and both halves were wrong in the same way. The ripple gave the whole
// slope a single regular corrugation, and the per-texel random gave every texel an unrelated
// normal, which under a specular term is white speckle over the entire hill -- visible in any
// wide shot as a fizz that does not belong to anything. Neither is what snow does.
//
// What snow does is ANISOTROPIC. Wind lays it in long low lines, and the direction of those lines
// is the most legible thing on an untouched slope under a grazing sun, which is why the octaves
// below are six cells across and twenty-two down rather than square.
export function snowNormalMap(size = 512) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const hgt = new Float32Array(size * size);
  const h = (x, y) => hgt[((y + size) % size) * size + ((x + size) % size)];
  //          across, along, amplitude, seed
  const OCT = [[6, 22, 1.00, 1], [12, 40, 0.46, 2], [26, 74, 0.22, 3], [60, 108, 0.11, 4]];
  for (const [cx, cy, amp, seed] of OCT) {
    const n = tiling(size, cx, cy, seed);
    for (let i = 0; i < hgt.length; i++) hgt[i] += n[i] * amp;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
    const nx = -dx * 0.55, ny = -dy * 0.55, nz = 1;   // 0.06 then scaled again by 0.55 was a flat map
    const l = Math.hypot(nx, ny, nz), i = (y * size + x) * 4;
    d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255;
    d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

// Two things a standard material will not do for snow on its own, injected into its shader:
//
//   SPARKLE. Snow is a heap of flat crystals, and a few of them per square metre happen to be
//   angled straight at you. That is the glitter, and it is a specular spike from a surface that
//   is otherwise rough, so no amount of roughness tuning produces it.
//
//   SUBSURFACE. Light goes into snow, bounces around and comes back out, which is why shadows on
//   snow are blue and bright rather than dark and grey. Without it snow lit by a low sun looks
//   like grey plastic.
export function patchSnowMaterial(mat, { sparkle = 1, subsurface = 1, aerial = 1, texture = null } = {}) {
  const mean = (texture && texture.userData.meanLinear) || [0.807, 0.847, 0.913];
  mat.userData.realUniforms = {
    uSnowBase: { value: new THREE.Vector3(mean[0], mean[1], mean[2]) },
    uAerial: { value: aerial },
    uSparkle: { value: sparkle },
    uSubsurface: { value: subsurface },
    uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2) },
    uSkyTint: { value: new THREE.Color(0x6f9fe0) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.realUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
      varying vec3 vRealWorld;
      varying vec3 vRealNormal;
      attribute vec2 aSnow;
      varying vec2 vSnow;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vRealWorld = (modelMatrix * vec4(transformed,1.0)).xyz;
      vRealNormal = normalize(mat3(modelMatrix) * objectNormal);
      vSnow = aSnow;`);
    shader.fragmentShader = shader.fragmentShader
      // CORDUROY BELONGS ON THE PISTE AND NOWHERE ELSE.
      //
      // This texture was multiplied over every square metre of every map, so the gully walls, the
      // summit headwall, the cornice, the rock chute and the village apron all wore the same
      // machine lines -- and when every surface on a mountain is the same surface there is
      // nothing for the eye to measure any of it against. That is what "it looks empty" was.
      //
      // Taking it back out is a subtraction rather than a second texture. The deviation of a
      // texel from the texture's own mean IS the pattern, so scaling that deviation toward zero
      // leaves exactly the mean behind and the snow does not change brightness by a hair. The
      // texture untouched snow does have then comes from the micro-relief below, which is where
      // it comes from in life too.
      //
      // The subtraction has to happen in the space the texel is in. map_fragment runs before
      // color_fragment, so here diffuseColor is the material colour times the texel and the
      // vertex colour has not arrived yet -- the mean is scaled by the material colour alone.
      .replace('#include <map_fragment>', `#include <map_fragment>
      #ifdef USE_MAP
        vec3 _base = uSnowBase * diffuse;
        diffuseColor.rgb = _base + ( diffuseColor.rgb - _base ) * mix( 0.14, 1.0, vSnow.x );
      #endif
      `)
      // TWO SCALES OF NORMAL. The map repeated once every 1.33 m and that single frequency was
      // the only thing you could actually see in the snow -- at riding height it read as fabric
      // weave. A second sample seven times finer, faded in over the last twenty metres, gives the
      // surface grain where your eye is and leaves the far slope alone. One extra texture fetch,
      // and only where the material is already sampling a normal map.
      .replace('#include <normal_fragment_maps>', `
    #ifdef USE_NORMALMAP_TANGENTSPACE
      float _nd = length( vViewPosition );
      float _fine = 1.0 - smoothstep( 4.0, 24.0, _nd );
      vec3 nA = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
      vec3 nB = texture2D( normalMap, vNormalMapUv * 7.3 ).xyz * 2.0 - 1.0;
      vec3 mapN = normalize( vec3( nA.xy + nB.xy * _fine * 0.85, nA.z ) );
      // Groomed snow is a machined surface with almost no micro-relief left on it; untouched snow
      // is nothing but micro-relief, and wind crust is the most textured thing on the hill. One
      // mask, three surfaces, no extra fetches.
      mapN.xy *= normalScale * mix( 1.45 + vSnow.y * 0.9, 0.42, vSnow.x );
      normal = normalize( tbn * mapN );
    #else
      #include <normal_fragment_maps>
    #endif
      `)
      // ROUGHNESS FROM THE SNOW ITSELF.
      //
      // This used to be two sines of the UV -- invented hundred-metre zones with no relationship
      // to anything on the map, which is a texture pretending to be information. It costs the
      // same three instructions to read the state that is actually there: a groomed strip is
      // smooth and picks up a sheen along the sun, wind crust is smoother still and close to
      // polished, and untouched powder is about as rough as a surface gets.
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
{
  float rough = mix( 1.06, 0.74, vSnow.x );          // powder -> piste
  rough = mix( rough, 0.62, vSnow.y );               // -> wind crust
  roughnessFactor = clamp( roughnessFactor * rough, 0.04, 1.0 );
}`)
      .replace('#include <common>', `#include <common>
varying vec3 vRealWorld;
varying vec3 vRealNormal;
uniform float uSparkle; uniform float uSubsurface; uniform float uAerial;
uniform vec3 uSunDir; uniform vec3 uSkyTint; uniform vec3 uSnowBase; varying vec2 vSnow;
float rhash(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  vec3 V = normalize(cameraPosition - vRealWorld);
  vec3 N = normalize(vRealNormal);
  float dist = length(cameraPosition - vRealWorld);
  // Subsurface: snow that is facing away from the sun is not dark, it is blue. The wrap term is
  // the cheap stand-in for light that went in somewhere else and came back out here.
  float wrap = clamp((dot(N, uSunDir) + 0.55) / 1.55, 0.0, 1.0);
  float ao = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  reflectedLight.indirectDiffuse += uSkyTint * uSubsurface * 0.62 * (1.0 - wrap) * ao;
  // and a touch of forward scatter when you are looking toward the sun across the surface
  float fwd = pow(clamp(dot(V, -uSunDir) * 0.5 + 0.5, 0.0, 1.0), 6.0);
  reflectedLight.indirectDiffuse += vec3(0.9, 0.93, 1.0) * uSubsurface * 0.22 * fwd;

  // Sparkle: pick out the handful of crystals per patch that are aimed at you.
  //
  // Glitter, not stipple. Fixed 2.9 cm cells with no distance term aliased into a regular
  // diagonal lattice lying on the slope -- a net thrown over the snow rather than light coming
  // off it. The cells now grow with distance so they stay above a pixel, and the whole term is
  // gone by 30 m, where individual crystals are not resolvable anyway.
  //
  // The previous fix overcorrected: gated to 6-30 m, then thinned to one cell in ten, then given a
  // specular exponent of 520, it could not be found in a single screenshot at any distance. The
  // range now starts at the board rather than six metres out, where a rider actually is.
  float near = 1.0 - smoothstep(3.0, 26.0, dist);
  if (near > 0.001) {
    float cellSize = 30.0 / (1.0 + dist * 0.5);
    vec3 cell = floor(vRealWorld * cellSize);
    float r1 = rhash(cell), r2 = rhash(cell + 7.1), r3 = rhash(cell + 19.3);
    vec3 facet = normalize(N + (vec3(r1, r2, r3) - 0.5) * 1.9);
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(facet, H), 0.0), 130.0);
    float rare = step(0.86, r3);   // one cell in seven, not one in four
    float grazing = smoothstep(0.0, 0.35, dot(N, uSunDir));
    reflectedLight.directSpecular += vec3(1.0, 0.99, 0.96) * spec * rare * grazing * uSparkle * near * 7.5;
  }
}`)
      // AERIAL PERSPECTIVE. White fog on white snow does nothing, which is why a ridge 800 m away
      // was arriving at exactly the contrast of the snow thirty metres from your feet. Distance
      // does not just wash a mountain out, it turns it BLUE, and three instructions of blue is
      // worth more here than any amount of fog. It has to sit after tone mapping and before the
      // existing fog, which takes over past a kilometre.
      .replace('#include <tonemapping_fragment>', `#include <tonemapping_fragment>
{
  float ad = length(cameraPosition - vRealWorld);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.60, 0.69, 0.84), smoothstep(110.0, 950.0, ad) * 0.36 * uAerial);
}`);
  };
  mat.needsUpdate = true;
  return mat;
}

// ---------------------------------------------------------------- trees
// Conifers built as a trunk plus many thin drooping tiers rather than three stacked cones. The
// silhouette is the whole thing at a distance: a real spruce is a ragged spike, not a party hat.
function tierGeo(r, hh, droop, seg) {
  // Closed, not open-ended: single-sided open cones vanish when you look up through the canopy.
  const g = new THREE.ConeGeometry(r, hh, seg, 1, false);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 0) {                                   // the skirt of each tier bends down and out
      const x = p.getX(i), z = p.getZ(i);
      const k = 1 + droop * 0.18;
      p.setXYZ(i, x * k, y - droop * 0.30 * hh, z * k);
    }
  }
  g.computeVertexNormals();
  return g;
}

export function realConifer({ height = 9, rand = Math.random, snowy = 0.7, dark = false } = {}) {
  const parts = [];
  const col = (g, hex) => {
    const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const trunkH = height * 1.02;
  parts.push(col(new THREE.CylinderGeometry(height * 0.012, height * 0.045, trunkH, 6).translate(0, trunkH / 2, 0), '#43331f'));
  const tiers = Math.round(9 + rand() * 4);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = height * (0.16 + t * 0.80);
    const r = height * (0.185 * Math.pow(1 - t, 1.25) + 0.022) * (0.84 + rand() * 0.32);
    const hh = height * (0.15 + 0.07 * (1 - t));
    const shade = dark ? (i % 2 ? '#1b4a32' : '#20573a') : (i % 2 ? '#26623c' : '#2c7046');
    const g = col(tierGeo(r, hh, 0.5 + rand() * 0.5, 7), shade).translate((rand() - 0.5) * r * 0.12, y, (rand() - 0.5) * r * 0.12);
    parts.push(g);
    // snow sitting on the upper side of the branches
    // Snow load, offset to one side and only on some tiers, because it does not sit evenly.
    if (rand() < snowy) {
      const off = r * 0.16;
      parts.push(col(tierGeo(r * (0.55 + rand() * 0.22), hh * 0.24, 0.2, 7), '#eef4ff')
        .translate((rand() - 0.5) * off * 2, y + hh * 0.26, (rand() - 0.5) * off * 2));
    }
  }
  // a bare leader at the very top
  parts.push(col(new THREE.ConeGeometry(height * 0.035, height * 0.14, 6), '#2c7046').translate(0, height * 1.0, 0));
  return parts;
}

export function realBirch({ height = 7, rand = Math.random } = {}) {
  const parts = [];
  const col = (g, hex) => {
    const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  parts.push(col(new THREE.CylinderGeometry(height * 0.016, height * 0.032, height, 6).translate(0, height / 2, 0), '#dfe3e6'));
  for (let i = 0; i < 7; i++) {
    const t = 0.45 + (i / 7) * 0.5;
    const len = height * (0.34 - t * 0.16), a = rand() * 6.28;
    const g = new THREE.CylinderGeometry(height * 0.004, height * 0.010, len, 4)
      .rotateZ(0.7 + rand() * 0.4).rotateY(a).translate(Math.cos(a) * len * 0.3, height * t, Math.sin(a) * len * 0.3);
    parts.push(col(g, '#cfd6da'));
  }
  return parts;
}
