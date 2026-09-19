// Heightfield mesh for a map (three.js). Shared by the game and the editor.
import * as THREE from 'three';
import { gridToWorld, slopeDegAt, heightAt, normalAt, PROP_TYPES } from './mapformat.js';
import { snowNormalMap, patchSnowMaterial } from './realism.js';

const _c = new THREE.Color();
const _ICE = new THREE.Color(0.58, 0.74, 0.84);

// Procedural "groomed corduroy" snow texture with a little sparkle noise.
export function makeSnowTexture(size = 512) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f7fb'; g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    // Corduroy: 8 lines per tile, so roughly one every 75 cm on the ground, at a contrast you
    // can actually see. Plus a coarse drift pattern, because a slope of pure parallel lines
    // reads as a machine part rather than as snow.
    // Amplitude 7 on a base of 240 is 3% in sRGB, and after linearisation and ACES it lands at
    // about 1.5% on screen -- which is to say it was not there. Corduroy is a strong, obvious
    // thing to look at on a groomed piste.
    const stripe = Math.sin((y / size) * Math.PI * 2 * 60) * 24;  // ~13 cm grooves on an 8 m tile
    // and a coarser band across them, because one frequency at one angle reads as machined cloth
    const coarse = Math.sin((y / size) * Math.PI * 2 * 7 + Math.sin((x / size) * 6.0) * 0.8) * 9;
    const drift = Math.sin((x / size) * Math.PI * 2 * 3 + (y / size) * 5.1) * 6;
    const n = (Math.random() - 0.5) * 9;
    const v = 238 + stripe + coarse + drift + n;
    d[i] = Math.max(0, v - 6); d[i + 1] = Math.max(0, v - 1); d[i + 2] = Math.min(255, v + 7); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 1);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;   // 4 was moire-ing badly at grazing angles
  return t;
}

// Relief shading. Snow in flat light is very nearly featureless, and a white heightfield lit
// only by a sun and tinted only by steepness is genuinely hard to read -- you cannot see a roller
// until you are already on it. Comparing each point against the average of its neighbours gives
// the local curvature: hollows go darker, crests go brighter, and the shape of the hill appears.
//
// Two radii, because a 4 m roll and a 30 m gully are both worth seeing and one radius cannot show
// both. This costs nothing at runtime -- it is baked into the vertex colours when the mesh is
// built, and recomputed only for the rect an editor brush actually touched.
const CURV_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const CURV_DZ = [0, 1, 1, 1, 0, -1, -1, -1];
function curvature(H, w, h, x, z, r) {
  let sum = 0;
  for (let k = 0; k < 8; k++) {
    const nx = Math.min(w - 1, Math.max(0, x + CURV_DX[k] * r));
    const nz = Math.min(h - 1, Math.max(0, z + CURV_DZ[k] * r));
    sum += H[nz * w + nx];
  }
  return H[z * w + x] - sum / 8;
}

export class Terrain {
  constructor(map, { shadows = true, texture = true, relief = 1, quality = 'fast' } = {}) {
    this.relief = relief; this.quality = quality;
    this.map = map;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.0,
      map: texture ? makeSnowTexture() : null,
      // snow is not shiny, but a dead-matte surface gives the sun nothing to shape it with
      roughness: quality === 'real' ? 0.66 : 0.82,
    });
    if (quality === 'real') {
      // Micro-relief and the two things a standard material cannot do for snow on its own.
      const nm = snowNormalMap(512);
      nm.repeat.set(6, 6);
      this.material.normalMap = nm;
      this.material.normalScale = new THREE.Vector2(0.55, 0.55);
      patchSnowMaterial(this.material, { sparkle: 1, subsurface: 1 });
    }
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'terrain';
    // A curtain hanging off the map's border. The heightfield has to stop somewhere, and where it
    // stops you were looking straight through the gap between its edge and the distant mountains
    // -- from anywhere near the boundary the world visibly ended in a cliff with sky behind it.
    // Dropping a skirt 400 m straight down closes it from every angle and costs 8 quads.
    this.skirtGeo = new THREE.BufferGeometry();
    // Its own material, and it is ROCK. Hanging the snow material off the edge gave a flat grey
    // slab that read as a hole in the world; a cliff band with a snow lip on top is what the edge
    // of a mountain actually looks like, and it hides the seam just as well.
    this.skirtMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });
    this.skirt = new THREE.Mesh(this.skirtGeo, this.skirtMat);
    this.skirt.name = 'terrain-skirt';
    this.skirt.frustumCulled = false;
    this.skirt.castShadow = false; this.skirt.receiveShadow = false;
    this.mesh.add(this.skirt);
    this.mesh.receiveShadow = shadows;
    // The hill shades ITSELF. Without this a roller has no shadow of its own, and the only
    // shadows on the whole slope come from trees -- which is most of why it reads as a flat
    // white sheet. With a low sun every lip and gully throws one.
    //
    // Except on a big open map. The terrain is one mesh with culling off, so the shadow pass
    // resubmits every triangle of it: at a square kilometre that is 230k triangles drawn twice a
    // frame, on a headset. Past that size the relief shading and the trees carry it instead.
    const cells = this.map.size.w * this.map.size.h;
    this.mesh.castShadow = shadows && cells < 90000;
    this.mesh.frustumCulled = false;
    this.colorMode = 'snow';   // 'snow' | 'slope' (editor overlay: steepness bands)
    this.rebuild();
  }

  setMap(map) { this.map = map; this.rebuild(); }

  rebuild() {
    const { w, h } = this.map.size, sp = this.map.spacing;
    const n = w * h;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = z * w + x, [wx, wz] = gridToWorld(this.map, x, z);
      pos[i * 3] = wx; pos[i * 3 + 1] = this.map.heights[i]; pos[i * 3 + 2] = wz;
      uv[i * 2] = x * sp / 8; uv[i * 2 + 1] = z * sp / 8;
    }
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)((w - 1) * (h - 1) * 6);
    let k = 0;
    for (let z = 0; z < h - 1; z++) for (let x = 0; x < w - 1; x++) {
      const a = z * w + x, b = a + 1, c = a + w, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh.geometry = this.geometry;
    this.bakeLight();
    this.updateRegion({ x0: 0, z0: 0, x1: w - 1, z1: h - 1 });
    this.geometry.computeBoundingSphere();
    this.buildSkirt();
  }

  // Where the sun is. Recolours the hill when it moves, and does nothing when it has not.
  setSun(dir) {
    if (!dir) return;
    const d = this.sunDir;
    if (d && Math.abs(d.x - dir.x) < 0.004 && Math.abs(d.y - dir.y) < 0.004 && Math.abs(d.z - dir.z) < 0.004) return;
    this.sunDir = { x: dir.x, y: dir.y, z: dir.z };
    this.bakeLight();
    this.recolor();
  }

  // SUN SHADOWING AND CONTACT SHADING, baked into the vertex colours.
  //
  // Nothing was casting a shadow onto this hill at any scale worth seeing. The shadow map is a
  // 220 m box around the rider, and terrain self-shadowing is switched off above 90k cells --
  // which is every open-mountain map there is. So eight hundred metres of mountain rendered at one
  // flat value, and the curvature shading was carrying the entire burden of making it readable.
  //
  // This is a horizon march: from each vertex, step toward the sun and ask whether anything on the
  // way rises above the sun's own elevation angle. It covers the whole map rather than 110 m of
  // it, it costs nothing per frame, and it is recomputed only when the sun moves. Steps are spaced
  // quadratically, so near ground -- where a 2 m lip is worth catching -- is sampled every cell,
  // and a ridge 500 m away still blocks.
  //
  // (An editor brush moves the ground without re-baking, so shadows go stale under the stroke
  // until something calls setSun or rebuild again. That is a fair trade for not spending 80 ms
  // per brush dab.)
  bakeLight() {
    const { w, h } = this.map.size, sp = this.map.spacing, H = this.map.heights;
    const n = w * h;
    if (!this.bake || this.bake.length !== n) this.bake = new Float32Array(n);
    this.bake.fill(1);
    const s = this.sunDir;
    if (s) {
      const horiz = Math.hypot(s.x, s.z) || 1e-6;
      const dx = s.x / horiz, dz = s.z / horiz, tanSun = s.y / horiz;
      const STEPS = 46, ts = new Float32Array(STEPS);
      for (let k = 0; k < STEPS; k++) ts[k] = (k + 1) * (1 + (k + 1) * 0.06);
      const soft = sp * 1.6;
      for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
        const i = z * w + x, y0 = H[i];
        let blocked = 0;
        for (let k = 0; k < STEPS; k++) {
          const t = ts[k];
          const gx = (x + dx * t + 0.5) | 0, gz = (z + dz * t + 0.5) | 0;
          if (gx < 0 || gz < 0 || gx >= w || gz >= h) break;
          const over = (H[gz * w + gx] - y0) - tanSun * t * sp;
          if (over > 0) {
            const f = Math.min(1, over / soft);
            if (f > blocked) { blocked = f; if (blocked >= 1) break; }
          }
        }
        this.bake[i] = 1 - blocked;
      }
    }
    // Contact shading wherever something stands in the snow. A tree with no darkening where it
    // meets the ground reads as a sticker on the slope, and this was the last thing in the scene
    // with no occlusion of any kind. Free at runtime: it is the same vertex colours.
    const marks = [];
    for (const p of this.map.props) {
      const t = PROP_TYPES[p.t];
      if (!t) continue;
      const big = p.t === 'hut' ? 4.5 : t.hard ? 1.2 + (p.s || 1) * 1.0 : 0;
      if (big > 0) marks.push([p.x, p.z, big]);
    }
    for (const l of (this.map.lifts || [])) { marks.push([l.base.x, l.base.z, 6]); marks.push([l.top.x, l.top.z, 6]); }
    for (const [px, pz, rad] of marks) {
      const cxg = px / sp + (w - 1) / 2, czg = pz / sp, rg = rad / sp;
      const z0 = Math.max(0, Math.floor(czg - rg)), z1 = Math.min(h - 1, Math.ceil(czg + rg));
      const x0 = Math.max(0, Math.floor(cxg - rg)), x1 = Math.min(w - 1, Math.ceil(cxg + rg));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const u = Math.hypot(x - cxg, z - czg) / rg;
        if (u >= 1) continue;
        this.bake[z * w + x] *= 1 - 0.34 * Math.pow(1 - u, 1.6);
      }
    }
  }

  // The border, extruded downwards. Reads the finished heights, so call it after updateRegion.
  buildSkirt() {
    if (!this.skirtGeo) return;
    const { w, h } = this.map.size, H = this.map.heights;
    let low = Infinity;
    for (let i = 0; i < H.length; i++) if (H[i] < low) low = H[i];
    // 400 m below the lowest point of the map was far below the valley floor disc that fills the
    // gap out to the distant peaks, and the map's edge heights vary by three hundred metres -- so
    // from the top of the hill the north border was a seven-hundred-metre curtain hanging in front
    // of everything. It only has to reach a little under the floor.
    const DEEP = low - 70;
    const edge = [];
    for (let x = 0; x < w; x++) edge.push([x, 0]);
    for (let z = 1; z < h; z++) edge.push([w - 1, z]);
    for (let x = w - 2; x >= 0; x--) edge.push([x, h - 1]);
    for (let z = h - 2; z >= 1; z--) edge.push([0, z]);
    const n = edge.length;
    // Three rows: a snow lip, then rock that darkens as it falls away.
    const rows = 7, vcount = n * rows;
    const pos = new Float32Array(vcount * 3), col = new Float32Array(vcount * 3), uv = new Float32Array(vcount * 2);
    const tint = (t, i, jitter) => {
      // t = 0 at the lip, 1 at the bottom.
      // The snow carries a good deal further down than it used to. Four and a half rows of rock
      // under a thin white line reads as a quarry face; a snowfield that gives way to rock as it
      // steepens reads as the mountain carrying on past the edge of the map, which is the entire
      // job of this thing.
      const snow = Math.max(0, 1 - t * 2.3);
      const r = (0.30 + jitter * 0.09) * (1 - snow) + 0.93 * snow;
      const g = (0.29 + jitter * 0.08) * (1 - snow) + 0.95 * snow;
      const b = (0.30 + jitter * 0.08) * (1 - snow) + 0.99 * snow;
      const dark = 1 - Math.min(0.45, t * 0.5);
      // and it washes toward the haze as it falls away, so it recedes instead of standing out as
      // the one hard-edged object on the horizon
      const haze = Math.min(0.5, t * 0.55);
      col[i * 3] = (r * dark) * (1 - haze) + 0.72 * haze;
      col[i * 3 + 1] = (g * dark) * (1 - haze) + 0.79 * haze;
      col[i * 3 + 2] = (b * dark) * (1 - haze) + 0.90 * haze;
    };
    for (let i = 0; i < n; i++) {
      const [gx, gz] = edge[i], [wx, wz] = gridToWorld(this.map, gx, gz);
      const y = H[gz * w + gx];
      const jitter = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
      for (let r = 0; r < rows; r++) {
        const t = r / (rows - 1);
        const v = i * rows + r;
        // It runs OUT as far as it drops -- about 32 degrees, which is a mountainside. A fixed few
        // metres of lean made it a vertical curtain, and the map's edge heights vary by three
        // hundred metres, so from the top of the hill the border behind you was a four-hundred-
        // metre wall hanging across the whole view. Tying the run to the drop means the steep
        // edges fall away into the distance instead of standing up in front of you.
        const drop = (y - DEEP) * (t * t);
        const run = drop * (1.35 + jitter * 0.75) + Math.sin(t * 9.1 + jitter * 6.3) * 5.0 * t;
        const cxs = Math.sign(wx) || 1, czs = gz === 0 ? -1 : gz === h - 1 ? 1 : 0;
        pos[v * 3] = wx + (gx === 0 || gx === w - 1 ? cxs * run : 0);
        pos[v * 3 + 1] = y - drop;
        pos[v * 3 + 2] = wz + czs * run;
        tint(t, v, jitter);
        uv[v * 2] = i * 0.35; uv[v * 2 + 1] = t * 40;
      }
    }
    const idx = new Uint32Array((n - 1) * (rows - 1) * 6);
    let k = 0;
    for (let i = 0; i < n - 1; i++) for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r, b = a + 1, c = a + rows, d = c + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = c; idx[k++] = b; idx[k++] = d;
    }
    this.skirtGeo.dispose();
    this.skirtGeo = new THREE.BufferGeometry();
    this.skirtGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.skirtGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.skirtGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.skirtGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.skirtGeo.computeVertexNormals();
    this.skirt.geometry = this.skirtGeo;
  }

  // Refresh vertex heights, normals and colours inside a grid rect (inclusive).
  updateRegion(r) {
    const { w, h } = this.map.size;
    const H = this.map.heights;
    const pos = this.geometry.attributes.position, col = this.geometry.attributes.color;
    const x0 = Math.max(0, r.x0 - 1), z0 = Math.max(0, r.z0 - 1), x1 = Math.min(w - 1, r.x1 + 1), z1 = Math.min(h - 1, r.z1 + 1);
    const nrm = [0, 1, 0];
    let nrmAttr0 = this.geometry.attributes.normal;
    if (!nrmAttr0) {
      this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(w * h * 3), 3));
      nrmAttr0 = this.geometry.attributes.normal;
    }
    const nrmCache = nrmAttr0.array;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const i = z * w + x;
      pos.array[i * 3 + 1] = this.map.heights[i];
      const [wx, wz] = gridToWorld(this.map, x, z);
      void wx;
      normalAt(this.map, wx, wz, nrm);
      nrmCache[i * 3] = nrm[0]; nrmCache[i * 3 + 1] = nrm[1]; nrmCache[i * 3 + 2] = nrm[2];
      const slope = Math.acos(Math.min(1, nrm[1])) * 57.2958;
      if (this.colorMode === 'slope') slopeBandColor(slope, _c);
      else {
        // fine picks up rollers and lips, broad picks up gullies and whole rolls of the hill
        const fine = curvature(H, w, h, x, z, 2);
        const broad = curvature(H, w, h, x, z, 7);
        const relief = Math.max(-1, Math.min(1, fine / 0.55 + broad / 4.0)) * this.relief;
        // Ambient occlusion, from a third and much wider curvature: concave ground sees less of
        // the sky, so it is darker and bluer. Nothing in the scene had any AO at all, which is
        // most of why everything looked like it was hovering above the snow rather than in it.
        const wide = curvature(H, w, h, x, z, 16);
        const ao = 1 - Math.max(0, Math.min(1, -wide / 9)) * 0.30;
        snowColor(slope, x, z, this.map.env?.snowType, relief, _c);
        _c.r *= ao; _c.g *= ao * 1.008; _c.b *= ao * 1.02;
        // frozen water, if the map says there is any here
        const ice = this.iceAt(wx, wz);
        if (ice > 0) _c.lerp(_ICE, ice * 0.85);
        // Baked sun. Snow out of the sun is not merely darker, it is BLUE -- it is lit by the sky
        // dome instead -- so the channels come down by different amounts. Flat darkening here
        // made the shadowed ground look grey and dirty.
        const lit = this.bake ? this.bake[i] : 1;
        if (lit < 0.999) {
          const k = (1 - lit) * (this.quality === 'real' ? 1 : 0.8);
          _c.r *= 1 - k * 0.44; _c.g *= 1 - k * 0.35; _c.b *= 1 - k * 0.19;
        }
      }
      col.array[i * 3] = _c.r; col.array[i * 3 + 1] = _c.g; col.array[i * 3 + 2] = _c.b;
    }
    // Normals for the dirty rect were filled in the loop above.
    const nrmAttr = nrmAttr0;
    // upload only the affected span of each buffer
    const from = z0 * w * 3, count = (z1 - z0 + 1) * w * 3;
    // three.js merges accumulated ranges and clears them itself after upload, so do NOT
    // clear them here -- that would drop earlier dirty rects from the same frame.
    for (const a of [pos, col, nrmAttr]) {
      if (a.addUpdateRange) { a.addUpdateRange(from, count); a.needsUpdate = true; }
      else a.needsUpdate = true;
    }
    this.geometry.boundingSphere = null;
  }

  // How much of this point is frozen lake, 0 to 1. Cheap: maps carry a handful of ellipses.
  iceAt(wx, wz) {
    const list = this.map.ice;
    if (!list || !list.length) return 0;
    let best = 0;
    for (const p of list) {
      const r = Math.hypot((wx - p.x) / p.rx, (wz - p.z) / p.rz);
      if (r < 1.12) best = Math.max(best, 1 - Math.max(0, (r - 0.72) / 0.4));
    }
    return best;
  }

  recolor() { const { w, h } = this.map.size; this.updateRegion({ x0: 0, z0: 0, x1: w - 1, z1: h - 1 }); }

  heightAt(x, z) { return heightAt(this.map, x, z); }
  normalAt(x, z, out) { return normalAt(this.map, x, z, out); }
  slopeAt(x, z) { return slopeDegAt(this.map, x, z); }
}

// Editor overlay: steepness bands (green flat -> blue -> amber -> red -> dark rock).
const BANDS = [[6, 0xdcfce7], [12, 0xbfdbfe], [20, 0x93c5fd], [28, 0x60a5fa], [35, 0xfde68a], [42, 0xfb923c], [50, 0xef4444], [90, 0x7f1d1d]];
function slopeBandColor(slopeDeg, out) {
  for (const [lim, hex] of BANDS) if (slopeDeg < lim) { out.setHex(hex); return; }
  out.setHex(0x7f1d1d);
}

// Snow tint: bright groomed white, bluer in the shade of steep faces, grey-brown rock above ~50 deg.
function snowColor(slopeDeg, x, z, snowType, relief, out) {
  const grain = ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1 + 1) % 1;
  let r = 0.93, g = 0.95, b = 0.985;
  if (snowType === 'powder') { r = 0.96; g = 0.97; b = 1.0; }
  if (snowType === 'ice') { r = 0.86; g = 0.92; b = 0.99; }
  const t = Math.min(1, Math.max(0, (slopeDeg - 30) / 25));      // 30..55 deg -> blue shade
  r = r * (1 - t * 0.28); g = g * (1 - t * 0.18); b = b * (1 - t * 0.05);
  const rock = Math.min(1, Math.max(0, (slopeDeg - 58) / 10));  // only near-vertical faces read as rock
  r = r * (1 - rock) + 0.38 * rock; g = g * (1 - rock) + 0.36 * rock; b = b * (1 - rock) + 0.34 * rock;
  // Relief: hollows darker AND bluer, crests brighter and a touch warmer. Snow in shadow is
  // strongly blue in life, and leaning on that colour shift rather than brightness alone keeps
  // the hill readable without making it look grey and dirty.
  const lift = 1 + relief * 0.26;
  const cool = Math.max(0, -relief);
  r *= lift * (1 - cool * 0.10);
  g *= lift * (1 - cool * 0.045);
  b *= lift * (1 + Math.max(0, relief) * -0.05 + cool * 0.02);
  const gr = (grain - 0.5) * 0.03;
  out.setRGB(Math.min(1, r + gr), Math.min(1, g + gr), Math.min(1, b + gr));
}
