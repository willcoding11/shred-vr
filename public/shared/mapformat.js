// Map format + pure-math helpers shared by the game, the editor and the node tools.
// No three.js here so it runs in node as well as the browser.
//
// Coordinates: x across the slope (0 at the centre line), z downhill (0 at the top),
// y up. heights[z * w + x] is metres. World x = (x - (w-1)/2) * spacing, world z = z * spacing.

export const MAP_VERSION = 2;

export const DIFFICULTIES = ['green', 'blue', 'black'];

// Catalogue of placeable things. `r` = collision radius (0 = decorative), `hard` = crash on hit.
export const PROP_TYPES = {
  pine:    { label: 'Pine tree',   r: 0.45, hard: true,  scale: [0.7, 1.6], color: '#2f6b3a' },
  fir:     { label: 'Fir tree',    r: 0.4,  hard: true,  scale: [0.8, 1.8], color: '#1f5a3c' },
  birch:   { label: 'Birch',       r: 0.25, hard: true,  scale: [0.8, 1.4], color: '#d9d2c5' },
  rock:    { label: 'Rock',        r: 0.9,  hard: true,  scale: [0.6, 1.6], color: '#6b7280' },
  boulder: { label: 'Boulder',     r: 2.2,  hard: true,  scale: [0.8, 1.8], color: '#4b5563' },
  gate:    { label: 'Slalom gate', r: 0,    hard: false, scale: [1, 1],     color: '#ef4444', width: 6 },
  flag:    { label: 'Marker flag', r: 0,    hard: false, scale: [1, 1],     color: '#f59e0b' },
  fence:   { label: 'Fence',       r: 0.6,  hard: true,  scale: [1, 1],     color: '#a16207', len: 6 },
  lamp:    { label: 'Trail lamp',  r: 0.25, hard: false, scale: [1, 1],     color: '#fbbf24' },
  sign:    { label: 'Trail sign',  r: 0.25, hard: false, scale: [1, 1],     color: '#7c2d12' },
  snowman: { label: 'Snowman',     r: 0.6,  hard: false, scale: [0.8, 1.2], color: '#f8fafc' },
  hut:     { label: 'Ski hut',     r: 3.5,  hard: true,  scale: [1, 1],     color: '#78350f' },
};

export function createMap({ id, name, w = 96, h = 320, spacing = 2, slopeDeg = 14, h0 = 0, difficulty = 'green' } = {}) {
  const heights = new Float32Array(w * h);
  const map = {
    version: MAP_VERSION, id, name, description: '', difficulty, order: 100,
    size: { w, h }, spacing,
    base: { h0, slopeDeg },
    heights,
    start: { x: 0, z: 12, yaw: 0 },
    finish: { x: 0, z: (h - 8) * spacing, w: 30 },
    props: [],
    env: { timeOfDay: 0.35, fog: 0.35, snowfall: 0.2, snowType: 'groomed', wind: 0.2 },
  };
  resetToBase(map);
  return map;
}

export function baseHeight(map, z) {
  return map.base.h0 - Math.tan((map.base.slopeDeg * Math.PI) / 180) * z;
}
export function resetToBase(map) {
  const { w, h } = map.size;
  for (let z = 0; z < h; z++) {
    const y = baseHeight(map, z * map.spacing);
    for (let x = 0; x < w; x++) map.heights[z * w + x] = y;
  }
}

// ---------- (de)serialisation ----------
export function encodeHeights(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function decodeHeights(b64, n) {
  let bytes;
  if (typeof Buffer !== 'undefined') bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  else { const s = atob(b64); bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i); }
  const out = new Float32Array(n);
  out.set(new Float32Array(bytes.buffer, bytes.byteOffset, Math.min(n, bytes.byteLength >> 2)));
  return out;
}
export function serializeMap(map) {
  return { ...map, heights: encodeHeights(map.heights) };
}
export function deserializeMap(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : json;
  const n = m.size.w * m.size.h;
  const heights = typeof m.heights === 'string' ? decodeHeights(m.heights, n) : Float32Array.from(m.heights);
  const out = { ...m, heights };
  out.props ||= [];
  out.env = { timeOfDay: 0.35, fog: 0.35, snowfall: 0.2, snowType: 'groomed', wind: 0.2, ...(m.env || {}) };
  out.base ||= { h0: heights[0] || 0, slopeDeg: 14 };
  out.start ||= { x: 0, z: 12, yaw: 0 };
  out.finish ||= { x: 0, z: (m.size.h - 8) * m.spacing, w: 30 };
  return out;
}
export function cloneMap(map) {
  return { ...structuredClone({ ...map, heights: null }), heights: new Float32Array(map.heights) };
}

// ---------- sampling ----------
export function worldToGrid(map, wx, wz) {
  return [wx / map.spacing + (map.size.w - 1) / 2, wz / map.spacing];
}
export function gridToWorld(map, gx, gz) {
  return [(gx - (map.size.w - 1) / 2) * map.spacing, gz * map.spacing];
}
export function heightAt(map, wx, wz) {
  const { w, h } = map.size;
  let [gx, gz] = worldToGrid(map, wx, wz);
  gx = Math.min(Math.max(gx, 0), w - 1.0001); gz = Math.min(Math.max(gz, 0), h - 1.0001);
  const x0 = gx | 0, z0 = gz | 0, fx = gx - x0, fz = gz - z0;
  const H = map.heights;
  const a = H[z0 * w + x0], b = H[z0 * w + x0 + 1], c = H[(z0 + 1) * w + x0], d = H[(z0 + 1) * w + x0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}
// Surface normal via central differences (returns [nx, ny, nz], unit length).
export function normalAt(map, wx, wz, out = [0, 1, 0]) {
  const e = map.spacing * 0.75;
  const hl = heightAt(map, wx - e, wz), hr = heightAt(map, wx + e, wz);
  const hd = heightAt(map, wx, wz - e), hu = heightAt(map, wx, wz + e);
  let nx = hl - hr, ny = 2 * e, nz = hd - hu;
  const l = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
  return out;
}
export function slopeDegAt(map, wx, wz) {
  const n = normalAt(map, wx, wz);
  return (Math.acos(Math.min(1, n[1])) * 180) / Math.PI;
}
export function bounds(map) {
  const hw = ((map.size.w - 1) * map.spacing) / 2;
  return { minX: -hw, maxX: hw, minZ: 0, maxZ: (map.size.h - 1) * map.spacing };
}

// ---------- brushes ----------
// Returns the dirty rect {x0, z0, x1, z1} in grid cells (inclusive) or null.
export const BRUSH_TOOLS = ['raise', 'lower', 'smooth', 'flatten', 'erase', 'noise', 'kicker', 'bank'];

// How far, in metres, a brush actually writes from its centre.
function brushReach(b) {
  if (b.tool === 'bank') return Math.max((b.bLen || b.radius), b.radius * 1.75);
  if (b.tool === 'kicker') return b.radius * 1.35;
  return b.radius;
}

export function applyBrush(map, b, scratch = {}) {
  const { w, h } = map.size, H = map.heights, sp = map.spacing;
  const [cgx, cgz] = worldToGrid(map, b.x, b.z);
  // The falloff is normalised on `radius`, but bank and kicker reach further than that, so
  // the write box has to be sized from each tool's real reach -- otherwise the tail the brush
  // draws to blend it into the hill is simply never written, and it ends in a wall.
  const rg = brushReach(b) / sp;
  const x0 = Math.max(0, Math.floor(cgx - rg)), x1 = Math.min(w - 1, Math.ceil(cgx + rg));
  const z0 = Math.max(0, Math.floor(cgz - rg)), z1 = Math.min(h - 1, Math.ceil(cgz + rg));
  if (x1 < x0 || z1 < z0) return null;
  const hard = b.falloff ?? 0.5;                // 0 = soft, 1 = hard edge
  const falloff = (d) => {                       // d in [0,1]
    if (d >= 1) return 0;
    const t = hard >= 0.999 ? 0 : Math.max(0, (d - hard) / (1 - hard));
    return 1 - t * t * (3 - 2 * t);
  };
  const str = b.strength ?? 0.5;
  const dt = b.dt ?? 1 / 60;
  const k = str * dt * 10;                       // metres per second at full strength ~ 5 m/s

  if (b.tool === 'flatten' && scratch.flattenY === undefined) {
    scratch.flattenY = heightAt(map, b.x, b.z);
  }
  let target = 0;
  if (b.tool === 'smooth' || b.tool === 'noise') {
    // pre-compute a blurred copy of the region so smoothing doesn't feed on itself
    scratch.tmp = new Float32Array((x1 - x0 + 1) * (z1 - z0 + 1));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      let s = 0, n = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
        s += H[zz * w + xx]; n++;
      }
      scratch.tmp[(z - z0) * (x1 - x0 + 1) + (x - x0)] = s / n;
    }
  }
  const rw = x1 - x0 + 1;
  const yaw = b.yaw || 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cgx) / rg, dz = (z - cgz) / rg;
      const d = Math.hypot(dx, dz);
      if (d >= 1 && b.tool !== 'kicker' && b.tool !== 'bank') continue;   // radial tools only
      const f = falloff(d);
      const i = z * w + x;
      switch (b.tool) {
        case 'raise': H[i] += k * f; break;
        case 'lower': H[i] -= k * f; break;
        case 'smooth': H[i] += (scratch.tmp[(z - z0) * rw + (x - x0)] - H[i]) * Math.min(1, f * str * dt * 30); break;
        case 'flatten': H[i] += (scratch.flattenY - H[i]) * Math.min(1, f * str * dt * 30); break;
        case 'erase': H[i] += (baseHeight(map, z * sp) - H[i]) * Math.min(1, f * str * dt * 30); break;
        case 'noise': {
          const n = hash2(x * 0.37 + b.seed, z * 0.41 - b.seed) - 0.5;
          const n2 = hash2(x * 1.7 + b.seed, z * 1.9) - 0.5;
          H[i] += (n * 1.6 + n2 * 0.5) * k * f * 2; break;
        }
        case 'kicker': {
          // A take-off ramp built ON TOP of the slope (additive): local coords rotated by yaw so the
          // lip faces `b.yaw`. u = along (-1 run-in .. +1 lip), v = across. The rise is packed into the
          // last 70% so the lip angle is ~30 deg above the slope for radius 9 / height 3.
          const lx = (x - cgx) * sp, lz = (z - cgz) * sp;
          const u = (lx * sy + lz * cy) / b.radius, v = (lx * cy - lz * sy) / (b.radius * 0.62);
          if (Math.abs(v) >= 1 || u < -1 || u > 1.3) break;
          const across = 1 - Math.pow(Math.abs(v), 4);        // flat deck, rounded shoulders
          const tt = Math.max(0, ((u + 1) / 1.85 - 0.3) / 0.7);
          // curved run-up, flat lip, then a short knuckle so the back is a slope not a wall
          const along = u <= 0.85 ? Math.pow(Math.min(1, tt), 2.6) : 1 - smooth01((u - 0.85) / 0.45);
          H[i] += along * across * b.height;
          break;
        }
        case 'bank': {
          // Berm: a smooth ridge that runs along `yaw` and rises on one side (b.side = +1/-1).
          // u = along the berm (-1..1), v = across, 0 at the inside edge .. 1.3 at the back of the crest.
          const lx = (x - cgx) * sp, lz = (z - cgz) * sp;
          // `bLen` is the half-length ALONG the berm; `radius` is how far it reaches across.
          // Keeping them separate lets a bank run 60-80 m without a steep end ramp.
          const u = (lx * sy + lz * cy) / (b.bLen || b.radius);
          const v = ((lx * cy - lz * sy) * (b.side || 1)) / (b.radius * 0.9);
          if (Math.abs(u) >= 1 || v < 0 || v > 1.85) break;
          const along = 1 - smooth01((Math.abs(u) - 0.55) / 0.45);
          // rise to the crest at v = 0.8, then a long shallow tail so the back of the berm
          // blends into the hill instead of becoming a cliff
          const prof = v <= 0.8 ? smooth01(v / 0.8) : 1 - smooth01((v - 0.8) / 1.05);
          H[i] += k * along * prof;
          break;
        }
      }
    }
  }
  return { x0, z0, x1, z1 };
}

// Deterministic noise helpers (value noise + fBm) used by the generator and the noise brush.
function smooth01(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }
export function hash2(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
export function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
export function fbm(x, y, oct = 4, lac = 2, gain = 0.5) {
  let s = 0, a = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * (valueNoise(x * f, y * f) * 2 - 1); norm += a; a *= gain; f *= lac; }
  return s / norm;
}

// Region helpers used by live sync (patch = rectangle of heights)
export function extractRegion(map, r) {
  const { w } = map.size, out = new Float32Array((r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1));
  let i = 0;
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) out[i++] = map.heights[z * w + x];
  return out;
}
export function applyRegion(map, r, data) {
  const { w } = map.size;
  let i = 0;
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) map.heights[z * w + x] = data[i++];
}
export function unionRect(a, b) {
  if (!a) return b; if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) };
}

// Stats used by the editor's info panel and the map critic.
// Lowest point on the map. The distant valley floor has to sit under this, or it cuts through
// the hill and hides everything below it.
export function lowestHeight(map) {
  const H = map.heights;
  let lo = Infinity;
  for (let i = 0; i < H.length; i++) if (H[i] < lo) lo = H[i];
  return Number.isFinite(lo) ? lo : 0;
}

export function mapStats(map) {
  const { w, h } = map.size, sp = map.spacing;
  let steep = 0, flat = 0, n = 0, maxSlope = 0;
  const hist = new Array(10).fill(0);
  for (let z = 1; z < h - 1; z += 2) for (let x = 1; x < w - 1; x += 2) {
    const [wx, wz] = gridToWorld(map, x, z);
    const s = slopeDegAt(map, wx, wz);
    maxSlope = Math.max(maxSlope, s);
    if (s > 35) steep++; if (s < 4) flat++;
    hist[Math.min(9, Math.floor(s / 5))]++;
    n++;
  }
  const drop = map.heights[0] - map.heights[(h - 1) * w];
  return {
    lengthM: (h - 1) * sp, widthM: (w - 1) * sp, verticalDropM: drop,
    avgGradeDeg: (Math.atan2(drop, (h - 1) * sp) * 180) / Math.PI,
    steepPct: (100 * steep) / n, flatPct: (100 * flat) / n, maxSlopeDeg: maxSlope,
    slopeHistogram: hist.map((c) => Math.round((100 * c) / n)),
    props: map.props.length,
    gates: map.props.filter((p) => p.t === 'gate').length,
  };
}
