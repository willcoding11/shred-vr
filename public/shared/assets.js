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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BASE = '/assets/';
// Name an object after one of these in Blender and it needs no manifest entry.
const TYPES = ['pine', 'fir', 'birch', 'rock', 'boulder', 'rail', 'hut', 'lamp', 'sign', 'snowman', 'fence'];
// how tall each one should end up, when the name alone tells us what it is
const DEFAULT_H = { pine: 8.4, fir: 10.2, birch: 7, rock: 1.2, boulder: 2.8, rail: 0.38, hut: 5.2, lamp: 3.6, sign: 2.2, snowman: 3.1, fence: 1.3 };

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
    const c = mats[0]?.color || new THREE.Color(0.8, 0.8, 0.8);
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
function normalise(geo, want) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  geo.translate(-cx, -b.min.y, -cz);
  const d = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
  const have = want.by === 'length' ? Math.max(d[0], d[2]) : want.by === 'width' ? Math.min(d[0], d[2]) : d[1];
  if (want.size > 0 && have > 1e-6) { const k = want.size / have; geo.scale(k, k, k); }
  geo.computeBoundingSphere();
  return geo;
}
// FIT: scale each axis separately to land on an exact box, rather than preserving proportions.
//
// For most props this would be vandalism. For a rail it is the only thing that works: the game's
// rail surface is a box 8 m long, 46 cm wide and 38 cm off the snow, and a rail modelled with legs
// a quarter of its own length cannot reach that by any uniform scale -- at the right length it
// stands 2.3 m tall, and at the right height it is 1.5 m long. Squashing the legs down is exactly
// the edit the model needs, so doing it on load is a fair stopgap while the model is what it is.
function fitBox(geo, target) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  geo.translate(-cx, -b.min.y, -cz);
  const d = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
  // the model's long axis becomes the box's long axis, whichever way round it was built
  const along = d[2] >= d[0] ? 2 : 0, across = along === 2 ? 0 : 2;
  const k = [1, 1, 1];
  k[across] = target[0] / Math.max(1e-6, d[across]);
  k[1] = target[1] / Math.max(1e-6, d[1]);
  k[along] = target[2] / Math.max(1e-6, d[along]);
  geo.scale(k[0], k[1], k[2]);
  if (along !== 2) geo.rotateY(Math.PI / 2);      // point it down +z like the procedural one
  geo.computeVertexNormals();                     // a non-uniform scale does not preserve normals
  geo.computeBoundingSphere();
  return geo;
}
const FIT_BOX = { rail: () => [PROP_TYPES.rail.railW, PROP_TYPES.rail.railH, PROP_TYPES.rail.len] };

// which dimension an entry asked to be sized by
const sizing = (entry, type, defaults) => (
  entry?.length != null ? { by: 'length', size: entry.length }
    : entry?.width != null ? { by: 'width', size: entry.width }
      : { by: 'height', size: entry?.height ?? defaults[type] ?? 1 });

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
      if (entry?.fit && FIT_BOX[entry.fit === true ? type : entry.fit]) fitBox(geo, FIT_BOX[entry.fit === true ? type : entry.fit]());
      else normalise(geo, sizing(entry, type, DEFAULT_H));
      (out[type] ||= []).push(geo);
    }
    const summary = Object.entries(out).map(([k, v]) => `${k}x${v.length}`).join(' ');
    if (summary) console.log('[assets] loaded from ' + src + ': ' + summary);
    return out;
  })();
  return cache;
}

export function clearAssetCache() { cache = null; }
