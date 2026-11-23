// Hand-modelled props, loaded from one glTF file and conditioned into what the game expects.
//
// The whole point is that modelling should not require thinking about the game's conventions. You
// build a tree in Blender at whatever size is convenient, with its origin wherever Blender put it,
// out of as many materials as you like, and this makes it into a prop: base on the ground, scaled
// to a sensible height, one material so the instancing still works.
//
// It is optional. If the file is missing, everything falls back to the procedural geometry and the
// game is exactly as it was.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PROP_TYPES } from './mapformat.js';
import { scaleFor, DEFAULT_H } from './propsize.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Page-relative, so it works under a sub-path too (GitHub Pages serves this at /shred-vr/).
// Every page that loads this sits one folder down: /game/, /editor/, /mixer/.
const BASE = '../assets/';
// Name an object after one of these in Blender and it needs no manifest entry.
const TYPES = ['pine', 'fir', 'birch', 'rock', 'boulder', 'rail', 'hut', 'lamp', 'sign', 'snowman', 'fence'];
// how tall each one should end up, when the name alone tells us what it is


// three.js SANITISES node names when it loads a glTF -- "Cube.003" arrives as "Cube003" -- so
// anything matching on the Blender name has to compare a normalised form or it silently matches
// nothing. That cost a debugging round: five of six objects were dropped and the sixth, the only
// one Blender had not suffixed, came through and made it look like the loader half-worked.
// Exactly what three.js does to a node name, so a manifest written with the Blender names still
// matches. It removes [ ] . : / and turns whitespace into underscores -- crucially it KEEPS the
// digits, so Cube.003 and Cube.001 stay distinct. Normalising the digits away as well collapsed
// every Cube to one entry and every Icosphere to another.
const sanitize = (s) => String(s).replace(/\s/g, '_').replace(/[[\].:/]/g, '');
// and a looser form, only for guessing a TYPE from a name: pine.001 and Rock_2 are pine and rock.
const norm = (s) => String(s).toLowerCase().replace(/[.\s_-]/g, '').replace(/\d+$/, '');
// "Cube003" -> null, "pine.001" -> "pine", "Rock_2" -> "rock"
const typeFromName = (name) => (TYPES.includes(norm(name)) ? norm(name) : null);

// NOTHING IN A WINTER FOREST IS THAT GREEN.
//
// The modelled conifer's needles arrive at (0.019, 0.367, 0.000) linear, which is a pure
// saturated green, about #26a300 on screen. Against snow that is the loudest colour anywhere in
// the frame, so in every wide shot the eye goes to the trees instead of to the mountain, and a
// stand of them reads as plastic cones planted in a field rather than as a forest. Real spruce
// and pine under snow are dark, blue-green and close to black in their own shade; the value is
// what makes a treeline read as a treeline from a kilometre away.
//
// Only foliage is touched, and foliage is any colour where green clearly dominates both other
// channels. Trunks, snow, rock, paint and window glass go through unchanged -- which matters,
// because this runs over every primitive of every modelled prop.
function grade(c) {
  if (!(c.g > c.r * 1.7 && c.g > c.b * 1.7 && c.g > 0.06)) return c;
  // Keep the relative brightness the model was built with, land it in a range that is dark and
  // blue rather than bright and pure.
  const t = Math.min(1, c.g / 0.37);
  return c.setRGB(0.030 + 0.020 * t, 0.074 + 0.056 * t, 0.049 + 0.031 * t);
}

// Bake each primitive's material colour into vertex colours and merge the lot into one geometry.
//
// Instancing needs one material per mesh, and the game's prop material is already vertexColors.
// glTF baseColorFactor is linear and so is a THREE.Color built from hex under colour management,
// so these two agree without a conversion.
function bake(object3d) {
  const parts = [];
  object3d.updateWorldMatrix(true, true);
  object3d.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const src = o.geometry;
    const g = src.index ? src.toNonIndexed() : src.clone();
    g.applyMatrix4(o.matrixWorld);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = grade(mats[0]?.color || new THREE.Color(0.8, 0.8, 0.8));
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // Anything the game does not read is dead weight in a buffer that ships to a headset.
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    parts.push(g);
  });
  return parts.length ? mergeGeometries(parts) : null;
}

// Base on the ground, centred on its own footprint, scaled to fit.
//
// Sized by whichever dimension you named: `height` for things defined by how tall they are, or
// `length` for things defined by how long they are -- a rail is a rail because it is eight metres
// long, not because it is however high off the snow you built it. The scale stays UNIFORM either
// way, so the proportions you modelled survive; if they are wrong for the game that is worth
// seeing rather than hiding under a squash.
function normalise(geo, entry, type) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  geo.translate(-cx, -b.min.y, -cz);
  const d = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
  const k = scaleFor(entry, type, d);
  if (k !== 1) geo.scale(k, k, k);
  geo.computeBoundingSphere();
  return geo;
}
// Whatever the model turns out to measure is what the game uses. PROP_TYPES carries the rail's
// width, height and length for the physics and for the procedural fallback, so a modelled rail
// overwrites those rather than being squashed into them: the board rides the rail you built.
function adoptSize(type, geo) {
  if (type !== 'rail') return;
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const d = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
  PROP_TYPES.rail.railW = +Math.min(d[0], d[2]).toFixed(3);
  PROP_TYPES.rail.railH = +d[1].toFixed(3);
  PROP_TYPES.rail.len = +Math.max(d[0], d[2]).toFixed(3);
}

let cache = null;

// Returns { pine: [geo, geo], rock: [geo], ... } -- an array per type, because several objects
// named pine, pine.001, pine.002 are variants of the same prop and the renderer spreads instances
// across them. Resolves to {} if there is nothing to load, which is not an error.
export async function loadAssets(file = 'props.glb') {
  if (cache) return cache;
  cache = (async () => {
    let manifest = { map: {} };
    try {
      const res = await fetch(BASE + 'manifest.json', { cache: 'no-store' });
      if (res.ok) manifest = await res.json();
    } catch { /* no manifest is fine; names alone may be enough */ }
    const src = manifest.source || file;
    let gltf;
    try {
      const head = await fetch(BASE + src, { method: 'HEAD' });
      if (!head.ok) return {};
      gltf = await new GLTFLoader().loadAsync(BASE + src);
    } catch (e) {
      console.warn('[assets] could not load ' + src + ':', e.message);
      return {};
    }
    // manifest keys, matched however they were written: exactly, or normalised past the dots
    // and digits that Blender adds and three.js then rewrites.
    const byName = new Map();
    for (const [k, v] of Object.entries(manifest.map || {})) {
      byName.set(k, v);
      byName.set(sanitize(k), v);
    }
    const out = {};
    for (const node of [...gltf.scene.children]) {
      const entry = byName.get(node.name) ?? byName.get(sanitize(node.name));
      if (entry?.type === 'skip') continue;
      const type = entry?.type || typeFromName(node.name);
      if (!type) continue;
      const geo = bake(node);
      if (!geo) continue;
      normalise(geo, entry, type);
      // A far model is a stand-in for the same prop past the full-detail radius, not another
      // variant of it -- it must not end up in the rotation of meshes placed up close, and it
      // must not be what the physics measures a rail by.
      const key = entry?.lod === 'far' ? type + '@far' : type;
      if (key === type) adoptSize(type, geo);
      (out[key] ||= []).push(geo);
    }
    const summary = Object.entries(out).map(([k, v]) => `${k}x${v.length}`).join(' ');
    if (summary) console.log('[assets] loaded from ' + src + ': ' + summary);
    return out;
  })();
  return cache;
}

export function clearAssetCache() { cache = null; }
