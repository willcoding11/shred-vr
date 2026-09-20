// Shred VR map editor: sculpt terrain, place objects, and stream every change to the headset.
import * as THREE from 'three';
import { Viewport } from './viewport.js';
import { LiveClient } from '../shared/live.js';
import { buildMountain, buildRun, PRESET_SIZES } from '../shared/mapgen.js';
import {
  createMap, deserializeMap, serializeMap, applyBrush, extractRegion, unionRect, mapStats,
  PROP_TYPES, heightAt, normalAt, slopeDegAt, bounds, fbm, gridToWorld,
} from '../shared/mapformat.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const TOOLS = {
  raise:   { label: 'Raise',        key: '1', kind: 'terrain', color: 0x38bdf8, hint: 'Drag to push the snow up' },
  lower:   { label: 'Lower',        key: '2', kind: 'terrain', color: 0xf472b6, hint: 'Drag to dig' },
  smooth:  { label: 'Smooth',       key: '3', kind: 'terrain', color: 0xa78bfa, hint: 'Drag to soften bumps and edges' },
  flatten: { label: 'Flatten',      key: '4', kind: 'terrain', color: 0x34d399, hint: 'Drag to level to the height where you started the stroke' },
  erase:   { label: 'Reset',        key: '5', kind: 'terrain', color: 0xfb7185, hint: 'Drag to restore the original base slope' },
  noise:   { label: 'Roughen',      key: '6', kind: 'terrain', color: 0xfbbf24, hint: 'Drag to add bumps and chop' },
  kicker:  { label: 'Kicker',       key: '7', kind: 'stamp',   color: 0xfacc15, hint: 'Click to stamp a take-off ramp facing downhill' },
  bank:    { label: 'Berm',         key: '8', kind: 'terrain', color: 0xf97316, hint: 'Drag along a turn; the berm rises on the chosen side' },
  place:   { label: 'Place',        key: 'Q', kind: 'prop',    color: 0x38bdf8, hint: 'Click to place the selected object' },
  scatter: { label: 'Scatter',      key: 'W', kind: 'prop',    color: 0x22c55e, hint: 'Drag to paint objects' },
  eraseProps: { label: 'Remove',    key: 'E', kind: 'prop',    color: 0xef4444, hint: 'Drag to remove objects' },
  select:  { label: 'Select',       key: 'R', kind: 'select',  color: 0xfacc15, hint: 'Click an object to select; drag to move; Delete removes' },
  start:   { label: 'Start',        key: 'F', kind: 'marker',  color: 0x22c55e, hint: 'Click to move the start gate' },
  finish:  { label: 'Finish',       key: 'G', kind: 'marker',  color: 0xef4444, hint: 'Click to move the finish line' },
  lift:    { label: 'Lift',         key: 'L', kind: 'marker',  color: 0xf59e0b, hint: 'Click the BASE, then click the TOP. Click an existing base again to remove it' },
};

const state = {
  map: null, maps: [], tool: 'raise',
  brush: { radius: 12, strength: 0.5, falloff: 0.5, height: 1.8, side: 1 },
  prop: { type: 'pine', scale: 1, randomScale: 0.35, randomRot: true, rot: 0, density: 0.5, gap: 6 },
  selected: -1, dirty: false, saving: false, follow: true, followRider: false,
  liftFrom: null,
  undo: [], redo: [],
  stroke: null,
};

const view = new Viewport($('view'), $('minimap'));
// Fly mode swaps the whole camera model, so say so plainly rather than leaving someone wondering
// why the mouse stopped orbiting.
view.onFly = (on) => {
  $('camhint').innerHTML = on
    ? '<b>WASD</b> move · <b>Space</b> up · <b>Shift</b> down · <b>Ctrl</b> boost · mouse look · wheel speed · <b>F</b> or <b>Esc</b> to stop'
    : 'Right-drag orbit · Middle-drag pan · Wheel zoom · [ ] brush size · <b>F</b> to fly';
  $('camhint').classList.toggle('flying', on);
};
// Same reason the game has shredRefs: checking a claim about what is on screen beats squinting.
window.shredEditor = () => ({ view, state,
  detail: view.terrain ? {
    lod: view.terrain.lod, tiles: view.terrain.chunks.length,
    tilesAtFullDetail: view.terrain.chunks.filter((c) => c.lod === 0 && c.mesh.visible).length,
    draws: view.renderer.info.render.calls, tris: view.renderer.info.render.triangles,
    propMeshes: view.props ? view.props.group.children.map((m) => m.name + 'x' + m.count).filter((n) => !n.endsWith('x0')) : [],
  } : null });
function showHint(t) { $('hint').textContent = t; }
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.liftFrom) { state.liftFrom = null; view.showLiftDraft(null); showHint(TOOLS.lift.hint); }
});
const live = new LiveClient('editor');
let counts = { game: 0, editor: 0 };

// ---------------- boot ----------------
async function refreshMaps() {
  state.maps = await (await fetch('/api/maps')).json();
  const sel = $('mapSelect'); sel.innerHTML = '';
  for (const m of state.maps) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; sel.appendChild(o); }
  if (state.map) sel.value = state.map.id;
}
let openSeq = 0;
async function openMap(id, { announce = true } = {}) {
  const seq = ++openSeq;
  const res = await fetch(`/api/maps/${id}`);
  if (!res.ok) { if (seq === openSeq) toast('Map not found'); return; }
  const json = await res.json();
  if (seq !== openSeq) return;           // a later switch already won
  clearTimeout(patchTimer); patchTimer = null; patchRect = null;
  clearTimeout(propsTimer); propsTimer = null;
  state.map = deserializeMap(json);
  state.undo = []; state.redo = []; state.selected = -1; state.dirty = false;
  view.setMap(state.map);
  view.showSelection(null);
  $('mapSelect').value = id;
  fillMapSettings(); fillEnv(); updateStats(); updateSaveState();
  localStorage.setItem('shred.editor.map', id);
  const url = new URL(location.href); url.searchParams.set('map', id); history.replaceState(null, '', url);
  if (announce && state.follow) live.send({ type: 'active', id });
  updateUndoButtons();
  setLive(live.connected);
}
(async () => {
  await refreshMaps();
  const wanted = new URL(location.href).searchParams.get('map') || localStorage.getItem('shred.editor.map') || state.maps[0]?.id;
  if (wanted && state.maps.some((m) => m.id === wanted)) await openMap(wanted, { announce: false });
  else if (state.maps[0]) await openMap(state.maps[0].id, { announce: false });
  else $('newLevel').showModal();
})();

// ---------------- live ----------------
live.on('welcome', (m) => {
  counts = m.counts || counts;
  // If the socket dropped while we were editing, the headset missed those patches and no
  // later message would repair it. Push the whole map once to resynchronise.
  if (live.dropped && state.map) { live.dropped = false; live.send({ type: 'map', map: serializeMap(state.map) }); toast('Reconnected, resent the map'); }
  setLive(true);
});
live.on('close', () => setLive(false));
live.on('clients', (m) => { counts = m.counts; setLive(true); });
live.on('maps', () => refreshMaps());
// Only the game's own telemetry tells us what the headset is really rendering. `active` is
// echoed to everyone including whoever sent it, so it cannot be used to detect divergence.
live.on('active', (msg) => {
  if (!msg.id || !state.map || msg.id === state.map.id) return;
  if (state.follow) { if (state.dirty) saveNow(); openMap(msg.id, { announce: false }); toast(`Followed to "${msg.id}"`); }
});
let headsetMap = null, headsetSeen = 0;
live.on('telemetry', (t) => {
  if (t.id && (t.id !== headsetMap)) { headsetMap = t.id; setLive(live.connected); }
  headsetSeen = performance.now();
  view.setRider(t);
  if (state.followRider && state.map && t.id === state.map.id) view.lookAtWorld(t.x, t.z, 60);
  $('riderInfo').textContent = t.id === state.map?.id ? `Rider · ${Math.round(t.speed * 3.6)} km/h · ${t.phase}` : '';
});
function setLive(on) {
  const el = $('live');
  // a headset that has gone quiet for a while is no longer telling us anything
  if (headsetMap && performance.now() - headsetSeen > 8000) headsetMap = null;
  const diverged = headsetMap && state.map && headsetMap !== state.map.id;
  el.className = 'pill live ' + (on ? (diverged ? 'warn' : 'on') : 'off');
  el.textContent = !on ? 'Reconnecting…'
    : diverged ? `Headset is on "${headsetMap}"`
      : counts.headset ? `${counts.headset} headset${counts.headset > 1 ? 's' : ''} live`
        : counts.preview ? `${counts.preview} preview${counts.preview > 1 ? 's' : ''} · no headset`
          : 'Live · no headset yet';
  el.title = diverged ? 'Your edits are not reaching the headset because it is on a different map. Turn on "Headset follows editor", or switch to that map.'
    : counts.preview ? `${counts.preview} desktop preview tab(s) on this PC are connected as well.` : '';
}

// ---------------- saving ----------------
let saveTimer = null;
function markDirty({ terrain = false, props = false, env = false, full = false } = {}) {
  state.dirty = true; updateSaveState();
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400);
  if (props) sendProps();
  if (env) live.send({ type: 'env', id: state.map.id, env: state.map.env });
  if (full) live.send({ type: 'map', map: serializeMap(state.map) });
  if (terrain || props) updateStatsSoon();
  view.minimapDirty = true;
}
async function saveNow() {
  if (!state.map || !state.dirty) return;
  state.saving = true; updateSaveState();
  try {
    const res = await fetch(`/api/maps/${state.map.id}?quiet=1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(serializeMap(state.map)) });
    if (!res.ok) throw new Error(await res.text());
    state.dirty = false;
  } catch (e) { toast('Save failed: ' + e.message, true); }
  state.saving = false; updateSaveState();
}
function updateSaveState() {
  const el = $('saveState');
  el.className = 'pill save ' + (state.saving ? 'saving' : state.dirty ? 'dirty' : 'clean');
  el.textContent = state.saving ? 'Saving…' : state.dirty ? 'Unsaved' : 'Saved';
}
let propsTimer = null;
function sendProps() {
  // Throttle, not debounce: a trailing debounce never fires during a continuous scatter drag,
  // so nothing reached the headset until the mouse came up.
  if (propsTimer) return;
  const id = state.map.id;               // capture: a map switch before the timer fires would mislabel this
  propsTimer = setTimeout(() => {
    propsTimer = null;
    if (!state.map || state.map.id !== id) return;
    // EVERYTHING that is not heights. This used to carry props, start and finish only, so a
    // chairlift you placed never reached the game at all -- the only way to see it was to close
    // the game, reload the tab and open it again, which is exactly what live sync exists to avoid.
    // Cheap enough to send whole: a map with two lifts and two thousand props is a few tens of kB.
    live.send({ type: 'props', id, props: state.map.props,
      start: state.map.start, finish: state.map.finish,
      lifts: state.map.lifts || [], ice: state.map.ice || null, tarn: state.map.tarn || null,
      dropIns: state.map.dropIns || null, freeride: !!state.map.freeride,
      name: state.map.name, difficulty: state.map.difficulty });
  }, state.map && state.map.props.length > 200 ? 240 : 80);
}
let patchRect = null, patchTimer = null;
function queuePatch(rect) {
  patchRect = unionRect(patchRect, rect);
  if (!patchTimer) patchTimer = setTimeout(flushPatch, 60);
}
// A wide brush dragged a long way can union a rect of tens of thousands of cells; sent raw
// as JSON that is megabytes a second over Wi-Fi to the headset. Split anything large into
// tiles and round to the centimetre.
const PATCH_MAX_CELLS = 4096;
// Terrain edits move the ground that other things stand on. Rather than rebuild those on every
// brush dab, they settle once the stroke stops.
let settleTimer = null;
function settleAfterTerrain() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (!state.map) return;
    view.refreshLifts();                 // towers are grown from the ground under them
    view.terrain?.setSun(view.scenery.sunDir);
  }, 500);
}
function flushPatch() {
  patchTimer = null;
  if (!patchRect || !state.map) return;
  settleAfterTerrain();
  const id = state.map.id;
  const send = (r) => live.send({
    type: 'patch', id, rect: r,
    heights: Array.from(extractRegion(state.map, r), (v) => Math.round(v * 100) / 100),
  });
  const tiles = [patchRect];
  while (tiles.length) {
    const r = tiles.pop();
    const rw = r.x1 - r.x0 + 1, rh = r.z1 - r.z0 + 1;
    if (rw * rh <= PATCH_MAX_CELLS) { send(r); continue; }
    if (rh >= rw) { const mid = (r.z0 + r.z1) >> 1; tiles.push({ ...r, z1: mid }, { ...r, z0: mid + 1 }); }
    else { const mid = (r.x0 + r.x1) >> 1; tiles.push({ ...r, x1: mid }, { ...r, x0: mid + 1 }); }
  }
  patchRect = null;
}

// ---------------- undo ----------------
function pushUndo(entry) { state.undo.push(entry); if (state.undo.length > 40) state.undo.shift(); state.redo = []; updateUndoButtons(); }
// Terrain undo stores only the rect that changed. A full snapshot pair is ~250 KB per stroke,
// which reached ~10 MB over a long session.
function terrainEntry(beforeHeights, rect) {
  if (!rect) return null;
  const { w } = state.map.size;
  const rw = rect.x1 - rect.x0 + 1, rh = rect.z1 - rect.z0 + 1;
  const before = new Float32Array(rw * rh), after = new Float32Array(rw * rh);
  let i = 0;
  for (let z = rect.z0; z <= rect.z1; z++) for (let x = rect.x0; x <= rect.x1; x++, i++) {
    before[i] = beforeHeights[z * w + x];
    after[i] = state.map.heights[z * w + x];
  }
  return { type: 'terrain', rect, before, after };
}
// The whole non-terrain state: props, the start and finish markers, and the lifts. Undo restores
// this wholesale, so anything left out of it is silently not undoable.
function snapshotProps() {
  const m = state.map;
  return { props: structuredClone(m.props), start: { ...m.start }, finish: { ...m.finish }, lifts: structuredClone(m.lifts || []) };
}
function snapshotMeta() { const m = state.map; return { env: { ...m.env }, name: m.name, description: m.description, difficulty: m.difficulty, order: m.order }; }
function applyMeta(s) {
  const m = state.map;
  m.env = { ...s.env }; m.name = s.name; m.description = s.description; m.difficulty = s.difficulty; m.order = s.order;
  fillMapSettings(); fillEnv(); view.terrain.recolor(); view.applyEnv();
  markDirty({ env: true }); refreshAfterSave();
}
// Coalesce a run of slider moves into one undo entry.
let metaPending = null, metaTimer = null;
function metaEdit(apply) {
  if (!metaPending) metaPending = snapshotMeta();
  apply();
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => { pushUndo({ type: 'meta', before: metaPending, after: snapshotMeta() }); metaPending = null; }, 600);
}
function applyUndo(entry, dir) {
  const m = state.map;
  if (entry.type === 'meta') { applyMeta(dir === 'undo' ? entry.before : entry.after); return; }
  if (entry.type === 'terrain') {
    const src = dir === 'undo' ? entry.before : entry.after;
    const { w } = m.size, r = entry.rect;
    let i = 0;
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++, i++) m.heights[z * w + x] = src[i];
    view.terrain.updateRegion(r);
    view.props.sync(); view.refreshMarkers();
    queuePatch(r); markDirty({ terrain: true });
  } else {
    const s = dir === 'undo' ? entry.before : entry.after;
    m.props = structuredClone(s.props); m.start = { ...s.start }; m.finish = { ...s.finish };
    m.lifts = structuredClone(s.lifts || []);
    view.props.sync(); view.refreshMarkers(); view.refreshLifts(); state.selected = -1; view.showSelection(null);
    markDirty({ props: true });
  }
}
function undo() { const e = state.undo.pop(); if (!e) return; applyUndo(e, 'undo'); state.redo.push(e); updateUndoButtons(); }
function redo() { const e = state.redo.pop(); if (!e) return; applyUndo(e, 'redo'); state.undo.push(e); updateUndoButtons(); }
function updateUndoButtons() { $('btnUndo').disabled = !state.undo.length; $('btnRedo').disabled = !state.redo.length; }

// ---------------- tools ----------------
function setTool(name) {
  if (!TOOLS[name]) return;
  state.tool = name;
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  const t = TOOLS[name];
  $('hint').textContent = t.hint;
  if (t !== TOOLS.lift) { state.liftFrom = null; view.showLiftDraft(null); }
  document.body.dataset.toolKind = t.kind;
  if (t.kind !== 'select') { state.selected = -1; view.showSelection(null); }
  $('secBrush').classList.toggle('hidden', !(t.kind === 'terrain' || t.kind === 'stamp' || name === 'scatter' || name === 'eraseProps'));
  $('secKicker').classList.toggle('hidden', name !== 'kicker');
  $('secBerm').classList.toggle('hidden', name !== 'bank');
  $('secProp').classList.toggle('hidden', !(name === 'place' || name === 'scatter'));
  $('secScatter').classList.toggle('hidden', name !== 'scatter');
  $('secSelected').classList.toggle('hidden', name !== 'select');
  $('secMarkers').classList.toggle('hidden', t.kind !== 'marker');
  $('brushStrengthRow').classList.toggle('hidden', !(t.kind === 'terrain'));
  // the bank brush has its own profile and ignores the edge falloff
  $('brushFalloffRow').classList.toggle('hidden', !(t.kind === 'terrain') || name === 'bank');
  view.hideGhost();
}
$$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

function downhillYaw(x, z) { const n = normalAt(state.map, x, z); return Math.atan2(n[0], n[2]); }

let lastHit = null, lastBankPos = null;
const canvas = $('view');
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.map) return;
  const hit = view.pick(e.clientX, e.clientY); if (!hit) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {}   // never let capture failure abort a stroke
  const t = TOOLS[state.tool], m = state.map;
  if (t.kind === 'terrain') {
    state.stroke = { kind: 'terrain', before: Float32Array.from(m.heights), scratch: {}, rect: null, last: hit };
    // `before` is a scratch copy, sliced down to the dirty rect when the stroke ends
    lastBankPos = { x: hit.x, z: hit.z };
    if (state.tool !== 'bank') strokeTerrain(hit, 1 / 60);
  } else if (state.tool === 'kicker') {
    const before = Float32Array.from(m.heights);
    const yaw = downhillYaw(hit.x, hit.z);
    const r = applyBrush(m, { tool: 'kicker', x: hit.x, z: hit.z, radius: state.brush.radius, height: state.brush.height, yaw });
    if (r) {
      view.terrain.updateRegion(r); queuePatch(r);
      const te = terrainEntry(before, r); if (te) pushUndo(te);
      markDirty({ terrain: true }); view.props.sync();
    }
  } else if (state.tool === 'place') {
    const before = snapshotProps();
    placeProp(hit, { single: true });
    pushUndo({ type: 'props', before, after: snapshotProps() });
    markDirty({ props: true });
  } else if (state.tool === 'scatter' || state.tool === 'eraseProps') {
    state.stroke = { kind: 'props', before: snapshotProps(), last: hit };
    strokeProps(hit);
  } else if (state.tool === 'select') {
    const i = nearestProp(hit.x, hit.z, Math.max(3, state.brush.radius * 0.3));
    state.selected = i; view.showSelection(i >= 0 ? m.props[i] : null); fillSelected();
    if (i >= 0) state.stroke = { kind: 'move', before: snapshotProps(), moved: false };
  } else if (state.tool === 'start') {
    const before = snapshotProps();
    m.start = { x: +hit.x.toFixed(2), z: +hit.z.toFixed(2), yaw: downhillYaw(hit.x, hit.z) };
    view.refreshMarkers(); view.refreshLifts(); fillMarkers(); pushUndo({ type: 'props', before, after: snapshotProps() }); markDirty({ props: true });
  } else if (state.tool === 'finish') {
    const before = snapshotProps();
    m.finish = { ...m.finish, x: +hit.x.toFixed(2), z: +hit.z.toFixed(2) };
    view.refreshMarkers(); view.refreshLifts(); fillMarkers(); pushUndo({ type: 'props', before, after: snapshotProps() }); markDirty({ props: true });
  } else if (state.tool === 'lift') {
    m.lifts ||= [];
    // Click an existing base to remove that lift, so one tool both places and deletes.
    const near = m.lifts.findIndex((l) => Math.hypot(l.base.x - hit.x, l.base.z - hit.z) < 22);
    if (near >= 0 && !state.liftFrom) {
      const before = snapshotProps();
      const gone = m.lifts.splice(near, 1)[0];
      view.refreshLifts(); pushUndo({ type: 'props', before, after: snapshotProps() }); markDirty({ props: true });
      toast(`Removed "${gone.name}"`);
      return;
    }
    if (!state.liftFrom) {
      state.liftFrom = { x: +hit.x.toFixed(2), z: +hit.z.toFixed(2) };
      view.showLiftDraft(state.liftFrom, state.liftFrom);
      showHint('Now click the TOP station. Esc cancels.');
      return;
    }
    const base = state.liftFrom, top = { x: +hit.x.toFixed(2), z: +hit.z.toFixed(2) };
    state.liftFrom = null; view.showLiftDraft(null);
    if (Math.hypot(top.x - base.x, top.z - base.z) < 60) { toast('Too short for a lift', true); showHint(TOOLS.lift.hint); return; }
    // whichever end is lower is the bottom, because nobody rides a lift downhill
    const lowFirst = heightAt(m, base.x, base.z) <= heightAt(m, top.x, top.z);
    const before = snapshotProps();
    const n = m.lifts.length + 1;
    m.lifts.push({ id: 'lift' + n, name: n === 1 ? 'Summit Express' : `Chair ${n}`,
      base: lowFirst ? base : top, top: lowFirst ? top : base });
    view.refreshLifts(); pushUndo({ type: 'props', before, after: snapshotProps() }); markDirty({ props: true });
    showHint(TOOLS.lift.hint);
    toast('Lift placed');
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.map) return;
  const hit = view.pick(e.clientX, e.clientY);
  lastHit = hit;
  updateCursor(hit);
  if (hit) $('coords').textContent = `x ${hit.x.toFixed(1)}  z ${hit.z.toFixed(1)}  ·  h ${hit.y.toFixed(1)} m  ·  ${hit.slope.toFixed(0)}°`;
  if (!state.stroke || !hit) return;
  const s = state.stroke;
  if (s.kind === 'terrain') {
    const dt = Math.min(0.05, (e.timeStamp - (s.t || e.timeStamp - 16)) / 1000); s.t = e.timeStamp;
    if (!state.dirty) { state.dirty = true; updateSaveState(); }
    if (state.tool === 'bank') {
      const d = Math.hypot(hit.x - lastBankPos.x, hit.z - lastBankPos.z);
      if (d > 1.0) {
        const yaw = Math.atan2(hit.x - lastBankPos.x, hit.z - lastBankPos.z);
        const r = applyBrush(state.map, { tool: 'bank', x: hit.x, z: hit.z, radius: state.brush.radius, strength: state.brush.strength, dt: d * 0.02, yaw, side: state.brush.side });
        if (r) { view.terrain.updateRegion(r); s.rect = unionRect(s.rect, r); queuePatch(r); }
        lastBankPos = { x: hit.x, z: hit.z };
      }
    } else strokeTerrain(hit, dt || 1 / 60);
  } else if (s.kind === 'props') strokeProps(hit);
  else if (s.kind === 'move' && state.selected >= 0) {
    const p = state.map.props[state.selected];
    p.x = +hit.x.toFixed(2); p.z = +hit.z.toFixed(2); s.moved = true;
    view.props.sync(); view.showSelection(p); sendProps();
  }
});
function endStroke() {
  const s = state.stroke; if (!s) return;
  state.stroke = null;
  if (s.kind === 'terrain') {
    flushPatch();
    const te = terrainEntry(s.before, s.rect);
    if (te) pushUndo(te);
    view.props.sync(); view.refreshMarkers();
    markDirty({ terrain: true });
  } else if (s.kind === 'props') { pushUndo({ type: 'props', before: s.before, after: snapshotProps() }); markDirty({ props: true }); }
  else if (s.kind === 'move' && s.moved) { pushUndo({ type: 'props', before: s.before, after: snapshotProps() }); markDirty({ props: true }); }
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
window.addEventListener('pointerup', endStroke);      // releasing outside the canvas still ends it
canvas.addEventListener('pointerleave', () => { if (!state.stroke) { view.updateCursor(null); view.hideGhost(); } });

function strokeTerrain(hit, dt) {
  const s = state.stroke, b = state.brush;
  const r = applyBrush(state.map, { tool: state.tool, x: hit.x, z: hit.z, radius: b.radius, strength: b.strength, falloff: b.falloff, dt, seed: 3.7 }, s.scratch);
  if (!r) return;
  view.terrain.updateRegion(r); s.rect = unionRect(s.rect, r); queuePatch(r);
}
function strokeProps(hit) {
  const m = state.map, b = state.brush;
  if (state.tool === 'eraseProps') {
    const n = m.props.length;
    m.props = m.props.filter((p) => Math.hypot(p.x - hit.x, p.z - hit.z) > b.radius);
    if (m.props.length !== n) { view.props.sync(); view.refreshMarkers(); sendProps(); }
  } else {
    const tries = Math.ceil(state.prop.density * b.radius * 0.6);
    let placed = 0;
    for (let i = 0; i < tries; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * b.radius;
      const x = hit.x + Math.cos(a) * d, z = hit.z + Math.sin(a) * d;
      if (!inBounds(x, z)) continue;
      if (nearestProp(x, z, state.prop.gap) >= 0) continue;
      placeProp({ x, z }, { single: false, sync: false }); placed++;
    }
    if (placed) { view.props.sync(); sendProps(); }
  }
}
function inBounds(x, z) { const b = bounds(state.map); return x > b.minX + 1 && x < b.maxX - 1 && z > b.minZ + 1 && z < b.maxZ - 1; }
function placeProp(hit, { single = true, sync = true } = {}) {
  const P = state.prop, def = PROP_TYPES[P.type];
  const jitter = single ? 0 : P.randomScale;
  const s = +(P.scale * (1 + (Math.random() * 2 - 1) * jitter)).toFixed(2);
  let r = P.randomRot ? Math.random() * Math.PI * 2 : P.rot;
  if (P.type === 'gate' || P.type === 'fence' || P.type === 'sign' || P.type === 'hut') r = P.type === 'gate' ? downhillYaw(hit.x, hit.z) : P.randomRot ? downhillYaw(hit.x, hit.z) + Math.PI / 2 : P.rot;
  // A rail points down the hill unless you have set a rotation yourself -- a box you have to
  // approach across the slope is a box nobody rides.
  if (P.type === 'rail' && P.rot === 0) r = downhillYaw(hit.x, hit.z);
  state.map.props.push({ t: P.type, x: +hit.x.toFixed(2), z: +hit.z.toFixed(2), s: def.scale ? s : 1, r: +r.toFixed(3) });
  if (P.type === 'rail') {
    // The box is LEVEL, and so is the surface you ride on it, so the ground underneath has to be
    // level too or it buries its uphill end. Flattening here means a rail dropped anywhere works
    // rather than needing you to prepare the ground first.
    const rad = def.len * (def.scale ? s : 1) * 0.75;
    applyBrush(state.map, { tool: 'smooth', x: hit.x, z: hit.z, radius: rad, strength: 1, dt: 1.0, falloff: 0.55 });
    applyBrush(state.map, { tool: 'smooth', x: hit.x, z: hit.z, radius: rad * 0.6, strength: 1, dt: 1.0, falloff: 0.9 });
    const b = bounds(state.map), sp = state.map.spacing;
    const g = (wx, wz) => [Math.round((wx - b.minX) / sp), Math.round(wz / sp)];
    const [x0, z0] = g(hit.x - rad, hit.z - rad), [x1, z1] = g(hit.x + rad, hit.z + rad);
    const rect = { x0: Math.max(0, x0), z0: Math.max(0, z0),
      x1: Math.min(state.map.size.w - 1, x1), z1: Math.min(state.map.size.h - 1, z1) };
    view.terrain.updateRegion(rect); view.terrain.setRails();
    queuePatch(rect); markDirty({ terrain: true });
  }
  if (sync) { view.props.sync(); }
}
function nearestProp(x, z, maxD) {
  let best = -1, bd = maxD;
  state.map.props.forEach((p, i) => { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = i; } });
  return best;
}
function updateCursor(hit) {
  const t = TOOLS[state.tool]; if (!t) return;
  if (t.kind === 'terrain' || t.kind === 'stamp' || state.tool === 'scatter' || state.tool === 'eraseProps') {
    const yaw = state.tool === 'kicker' && hit ? downhillYaw(hit.x, hit.z) : null;
    // a bank reaches ~1.67x its radius across, so show that rather than understating it
    const shown = state.tool === 'bank' ? state.brush.radius * 1.67 : state.brush.radius;
    view.updateCursor(hit, shown, { color: t.color, falloff: t.kind === 'terrain' && state.tool !== 'bank' ? state.brush.falloff : 1, yaw });
    view.hideGhost();
  } else if (state.tool === 'place') {
    view.updateCursor(null);
    const P = state.prop; const rot = P.type === 'gate' && hit ? downhillYaw(hit.x, hit.z) : P.randomRot ? 0 : P.rot;
    view.updateGhost(P.type, hit, P.scale, rot);
  } else { view.updateCursor(hit, Math.max(3, state.brush.radius * 0.3), { color: t.color, falloff: 1, visible: t.kind === 'select' }); view.hideGhost(); }
}

// ---------------- panels ----------------
function bindRange(id, obj, key, { fmt = (v) => v, after } = {}) {
  const el = $(id), out = el.parentElement.querySelector('output');
  el.value = obj[key]; if (out) out.textContent = fmt(obj[key]);
  el.addEventListener('input', () => { obj[key] = Number(el.value); if (out) out.textContent = fmt(obj[key]); after && after(); });
}
bindRange('brushRadius', state.brush, 'radius', { fmt: (v) => v + ' m', after: () => updateCursor(lastHit) });
bindRange('brushStrength', state.brush, 'strength', { fmt: (v) => Math.round(v * 100) + '%' });
bindRange('brushFalloff', state.brush, 'falloff', { fmt: (v) => (v < 0.3 ? 'soft' : v < 0.7 ? 'medium' : 'hard'), after: () => updateCursor(lastHit) });
bindRange('kickerHeight', state.brush, 'height', { fmt: (v) => v.toFixed(1) + ' m' });
$$('input[name=bermSide]').forEach((r) => r.addEventListener('change', () => { state.brush.side = Number(r.value); }));
bindRange('propScale', state.prop, 'scale', { fmt: (v) => v.toFixed(2) + '×' });
bindRange('propRandomScale', state.prop, 'randomScale', { fmt: (v) => Math.round(v * 100) + '%' });
bindRange('propRot', state.prop, 'rot', { fmt: (v) => Math.round((v * 180) / Math.PI) + '°' });
$('propRandomRot').addEventListener('change', (e) => { state.prop.randomRot = e.target.checked; $('propRotRow').classList.toggle('hidden', e.target.checked); });
bindRange('scatterDensity', state.prop, 'density', { fmt: (v) => Math.round(v * 100) + '%' });
bindRange('scatterGap', state.prop, 'gap', { fmt: (v) => v + ' m' });
// prop type grid
const grid = $('propGrid');
for (const [key, def] of Object.entries(PROP_TYPES)) {
  const b = document.createElement('button'); b.className = 'proptype' + (key === state.prop.type ? ' active' : ''); b.dataset.type = key;
  b.innerHTML = `<span class="swatch" style="background:${def.color}"></span><span>${def.label}</span>`;
  b.addEventListener('click', () => { state.prop.type = key; $$('.proptype').forEach((x) => x.classList.toggle('active', x.dataset.type === key)); });
  grid.appendChild(b);
}
// selected prop
function fillSelected() {
  const p = state.map?.props[state.selected];
  $('selNone').classList.toggle('hidden', !!p); $('selBody').classList.toggle('hidden', !p);
  if (!p) return;
  $('selType').textContent = PROP_TYPES[p.t]?.label || p.t;
  $('selScale').value = p.s || 1; $('selScale').parentElement.querySelector('output').textContent = (p.s || 1).toFixed(2) + '×';
  $('selRot').value = p.r || 0; $('selRot').parentElement.querySelector('output').textContent = Math.round(((p.r || 0) * 180) / Math.PI) + '°';
}
function editSelected(fn) {
  const p = state.map?.props[state.selected]; if (!p) return;
  const before = snapshotProps(); fn(p); view.props.sync(); view.showSelection(p);
  pushUndo({ type: 'props', before, after: snapshotProps() }); markDirty({ props: true });
}
$('selScale').addEventListener('input', (e) => { const p = state.map.props[state.selected]; if (p) { p.s = Number(e.target.value); e.target.parentElement.querySelector('output').textContent = p.s.toFixed(2) + '×'; view.props.sync(); sendProps(); } });
$('selScale').addEventListener('change', () => { markDirty({ props: true }); });
$('selRot').addEventListener('input', (e) => { const p = state.map.props[state.selected]; if (p) { p.r = Number(e.target.value); e.target.parentElement.querySelector('output').textContent = Math.round((p.r * 180) / Math.PI) + '°'; view.props.sync(); sendProps(); } });
$('selRot').addEventListener('change', () => { markDirty({ props: true }); });
$('selDelete').addEventListener('click', deleteSelected);
function deleteSelected() {
  if (state.selected < 0) return;
  const before = snapshotProps(); state.map.props.splice(state.selected, 1); state.selected = -1;
  view.props.sync(); view.showSelection(null); fillSelected();
  pushUndo({ type: 'props', before, after: snapshotProps() }); markDirty({ props: true });
}
// markers
function fillMarkers() {
  const m = state.map; if (!m) return;
  $('startX').value = m.start.x; $('startZ').value = m.start.z; $('finishX').value = m.finish.x; $('finishZ').value = m.finish.z; $('finishW').value = m.finish.w;
}
for (const id of ['startX', 'startZ', 'finishX', 'finishZ', 'finishW']) $(id).addEventListener('change', () => {
  const m = state.map, before = snapshotProps();
  m.start.x = Number($('startX').value); m.start.z = Number($('startZ').value); m.start.yaw = downhillYaw(m.start.x, m.start.z);
  m.finish.x = Number($('finishX').value); m.finish.z = Number($('finishZ').value); m.finish.w = Math.max(6, Number($('finishW').value));
  view.refreshMarkers(); pushUndo({ type: 'props', before, after: snapshotProps() }); markDirty({ props: true });
});
// map settings
function fillMapSettings() {
  const m = state.map;
  $('mapName').value = m.name; $('mapDesc').value = m.description || ''; $('mapDifficulty').value = m.difficulty || 'green'; $('mapOrder').value = m.order ?? 100;
  $('mapInfo').textContent = `${m.size.w}×${m.size.h} cells · ${m.spacing} m · ${((m.size.w - 1) * m.spacing)} × ${((m.size.h - 1) * m.spacing)} m`;
  fillMarkers();
}
$('mapName').addEventListener('change', (e) => { metaEdit(() => { state.map.name = e.target.value.trim() || state.map.name; }); e.target.value = state.map.name; markDirty(); refreshAfterSave(); });
$('mapDesc').addEventListener('change', (e) => { metaEdit(() => { state.map.description = e.target.value; }); markDirty(); });
$('mapDifficulty').addEventListener('change', (e) => { metaEdit(() => { state.map.difficulty = e.target.value; }); markDirty(); refreshAfterSave(); });
$('mapOrder').addEventListener('change', (e) => { metaEdit(() => { state.map.order = Number(e.target.value); }); markDirty(); refreshAfterSave(); });
function refreshAfterSave() { setTimeout(refreshMaps, 900); }
// environment
function fillEnv() {
  const e = state.map.env;
  $('envTime').value = e.timeOfDay; $('envFog').value = e.fog; $('envSnowfall').value = e.snowfall; $('envWind').value = e.wind; $('envSnow').value = e.snowType;
  for (const id of ['envTime', 'envFog', 'envSnowfall', 'envWind']) { const el = $(id); const out = el.parentElement.querySelector('output'); if (out) out.textContent = fmtEnv(id, Number(el.value)); }
}
function fmtEnv(id, v) { return id === 'envTime' ? (v < 0.25 ? 'dawn' : v < 0.45 ? 'morning' : v < 0.6 ? 'noon' : v < 0.8 ? 'afternoon' : 'dusk') : Math.round(v * 100) + '%'; }
for (const id of ['envTime', 'envFog', 'envSnowfall', 'envWind']) $(id).addEventListener('input', (e) => {
  const key = { envTime: 'timeOfDay', envFog: 'fog', envSnowfall: 'snowfall', envWind: 'wind' }[id];
  metaEdit(() => { state.map.env[key] = Number(e.target.value); });
  e.target.parentElement.querySelector('output').textContent = fmtEnv(id, state.map.env[key]);
  view.applyEnv(); markDirty({ env: true });
});
$('envSnow').addEventListener('change', (e) => { metaEdit(() => { state.map.env.snowType = e.target.value; }); view.terrain.recolor(); markDirty({ env: true }); });
$('envPreview').addEventListener('change', (e) => { view.previewEnv = e.target.checked; view.applyEnv(); });
$('viewSlope').addEventListener('change', (e) => view.setColorMode(e.target.checked ? 'slope' : 'snow'));
$('followRider').addEventListener('change', (e) => { state.followRider = e.target.checked; });
// stats
let statsTimer = null;
function updateStatsSoon() { clearTimeout(statsTimer); statsTimer = setTimeout(updateStats, 400); }
function updateStats() {
  if (!state.map) return;
  const s = mapStats(state.map);
  $('stats').innerHTML = [
    ['Length', `${s.lengthM} m`], ['Width', `${s.widthM} m`], ['Vertical', `${s.verticalDropM.toFixed(0)} m`], ['Avg grade', `${s.avgGradeDeg.toFixed(1)}°`],
    ['Max slope', `${s.maxSlopeDeg.toFixed(0)}°`], ['Steep (>35°)', `${s.steepPct.toFixed(1)}%`], ['Flat (<4°)', `${s.flatPct.toFixed(1)}%`], ['Objects', `${s.props} · ${s.gates} gates`],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
  const hist = s.slopeHistogram, max = Math.max(1, ...hist);
  $('histogram').innerHTML = hist.map((v, i) => `<div class="bar" title="${i * 5}–${i * 5 + 5}°: ${v}%"><i style="height:${(100 * v) / max}%"></i></div>`).join('');
}

// ---------------- map management ----------------
$('mapSelect').addEventListener('change', (e) => { if (state.dirty) saveNow(); openMap(e.target.value); });
$('btnNew').addEventListener('click', () => { $('newName').value = ''; $('newLevel').showModal(); $('newName').focus(); });
$('btnDuplicate').addEventListener('click', async () => {
  if (!state.map) return;
  const name = await ask({ title: 'Duplicate map', value: state.map.name + ' copy', ok: 'Duplicate' });
  if (!name) return;
  const copy = { ...serializeMap(state.map), id: uniqueId(slug(name)), name, order: (state.map.order ?? 100) + 1 };
  const res = await fetch('/api/maps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(copy) });
  if (!res.ok) { toast('Could not duplicate (name taken?)', true); return; }
  await refreshMaps(); openMap(copy.id); toast('Duplicated');
});
$('btnRename').addEventListener('click', async () => {
  if (!state.map) return;
  const n = await ask({ title: 'Rename map', value: state.map.name, ok: 'Rename' });
  if (n) { metaEdit(() => { state.map.name = n; }); fillMapSettings(); markDirty(); refreshAfterSave(); }
});
$('btnDelete').addEventListener('click', async () => {
  if (!state.map) return;
  const ok = await ask({ title: `Delete "${state.map.name}"?`, body: 'The map is moved to maps/.trash on the server, so it can be recovered by hand if you change your mind.', ok: 'Delete', danger: true });
  if (!ok) return;
  await fetch(`/api/maps/${state.map.id}`, { method: 'DELETE' });   // server moves it to maps/.trash
  state.map = null; await refreshMaps();
  if (state.maps[0]) openMap(state.maps[0].id); else $('newLevel').showModal();
  toast('Deleted');
});
$('btnSave').addEventListener('click', () => { state.dirty = true; saveNow(); });
$('btnUndo').addEventListener('click', undo); $('btnRedo').addEventListener('click', redo);
$('btnFrameStart').addEventListener('click', () => view.frameStart());
$('btnFrameAll').addEventListener('click', () => view.frameAll());
$('followHeadset').addEventListener('change', (e) => { state.follow = e.target.checked; if (state.follow && state.map) live.send({ type: 'active', id: state.map.id }); });
// No `?map=` here: that is the explicit pin, and it would stop the preview following the editor.
$('btnOpenGame').addEventListener('click', () => window.open('/game/', 'shred-game'));
$('btnHeadset').addEventListener('click', async () => {
  const info = await (await fetch('/api/info')).json();
  $('qr').src = info.qr; $('httpsUrl').textContent = info.httpsUrl; $('httpUrl').textContent = 'http://localhost:' + info.httpPort + '/game/';
  $('headsetDlg').showModal();
});
$$('dialog .close').forEach((b) => b.addEventListener('click', (e) => e.target.closest('dialog').close()));
// The "More" menu mirrors the commands the header folds away on a narrow window.
$('btnMore').addEventListener('click', (e) => {
  e.stopPropagation();
  const w = $('moreWrap'); const open = w.classList.toggle('open');
  $('btnMore').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#moreWrap')) $('moreWrap').classList.remove('open'); });
for (const [mirror, source] of [['btnSaveM', 'btnSave'], ['btnOpenGameM', 'btnOpenGame'], ['btnNewM', 'btnNew'], ['btnDuplicateM', 'btnDuplicate'], ['btnRenameM', 'btnRename'], ['btnDeleteM', 'btnDelete']]) {
  $(mirror).addEventListener('click', () => { $('moreWrap').classList.remove('open'); $(source).click(); });
}
// keep the two "headset follows editor" checkboxes in step
for (const [a, b] of [['followHeadset', 'followHeadsetM'], ['followHeadsetM', 'followHeadset']]) {
  $(a).addEventListener('change', (e) => { $(b).checked = e.target.checked; });
}
$('followHeadsetM').addEventListener('change', (e) => {
  state.follow = e.target.checked;
  if (state.follow && state.map) live.send({ type: 'active', id: state.map.id });
});
$('minimap').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  const p = view.minimapToWorld((e.clientX - r.left) * (e.target.width / r.width), (e.clientY - r.top) * (e.target.height / r.height));
  if (p) view.lookAtWorld(p.x, p.z, 90);
});

// new level
const PRESETS = {
  green: { slope: 10, length: 640, width: 190, roughness: 0.3, valley: 1, difficulty: 'green' },
  blue:  { slope: 15, length: 800, width: 220, roughness: 0.5, valley: 1, difficulty: 'blue' },
  black: { slope: 22, length: 880, width: 220, roughness: 0.7, valley: 1, difficulty: 'black' },
  park:  { slope: 12, length: 500, width: 160, roughness: 0.1, valley: 0.5, difficulty: 'blue' },
  flat:  { slope: 8, length: 400, width: 200, roughness: 0, valley: 0, difficulty: 'green' },
};

// What KIND of map, then how big. Everything else is fine tuning, and a mountain and a run are
// different enough shapes that picking between them with a slope number never worked.
function newKind() { return document.querySelector('input[name="newKind"]:checked')?.value || 'mountain'; }
function syncNewSize() {
  const k = newKind(), size = $('newSize').value, p = PRESET_SIZES[k][size];
  $('newLength').value = p.lengthM; $('newWidth').value = p.widthM; $('newSpacing').value = String(p.spacing);
  const cells = Math.round(p.widthM / p.spacing + 1) * Math.round(p.lengthM / p.spacing + 1);
  $('newSizeNote').textContent = k === 'mountain'
    ? `${p.lengthM} x ${p.widthM} m of open hill, ${p.spacing} m grid (${(cells / 1000).toFixed(0)}k cells). Drains to one base area, comes with a chairlift.`
    : `${p.lengthM} m long, ${p.widthM} m wide, ${p.spacing} m grid (${(cells / 1000).toFixed(0)}k cells). Start at the top, finish at the bottom.`;
  $('newValley').closest('label').style.display = k === 'mountain' ? 'none' : '';
  $('newSlope').closest('label').style.display = k === 'mountain' ? 'none' : '';
}
for (const el of document.querySelectorAll('input[name="newKind"]')) el.addEventListener('change', syncNewSize);
$('newSize').addEventListener('change', syncNewSize);
syncNewSize();

$('newLevelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('newName').value.trim() || 'Untitled';
  const kind = newKind();
  const spacing = Number($('newSpacing').value);
  const w = Math.max(24, Math.round(Number($('newWidth').value) / spacing) + 1);
  const h = Math.max(40, Math.round(Number($('newLength').value) / spacing) + 1);
  const map = createMap({ id: uniqueId(slug(name)), name, w, h, spacing, slopeDeg: Number($('newSlope').value), difficulty: $('newDifficulty').value });
  const rough = Number($('newRough').value);
  if (kind === 'mountain') buildMountain(map, { rough: Math.max(0.2, rough * 3) });
  else buildRun(map, { slopeDeg: Number($('newSlope').value), rough, valley: Number($('newValley').value) });
  map.order = (state.maps.at(-1)?.order ?? 99) + 1;
  const res = await fetch('/api/maps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(serializeMap(map)) });
  if (!res.ok) { toast('Could not create map', true); return; }
  $('newLevel').close(); await refreshMaps(); openMap(map.id); setTool('raise');
  toast(`Created "${name}"`);
});
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'map'; }
function uniqueId(base) { let id = base, i = 2; while (state.maps.some((m) => m.id === id)) id = `${base}-${i++}`; return id; }

// ---------------- keyboard ----------------
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); state.dirty = true; saveNow(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === '[' || e.key === ']') { const el = $('brushRadius'); el.value = Math.max(2, Math.min(80, Number(el.value) + (e.key === ']' ? 2 : -2))); el.dispatchEvent(new Event('input')); return; }
  if (e.key === 'Escape') { state.selected = -1; view.showSelection(null); fillSelected(); return; }
  if (e.key === 'Home') { view.frameAll(); return; }
  for (const [name, t] of Object.entries(TOOLS)) if (e.key.toUpperCase() === t.key) { setTool(name); return; }
});

// ---------------- dialogs ----------------
// A promise-based replacement for window.prompt / window.confirm, so every modal in the
// editor looks the same.
function ask({ title, body = '', value = null, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('promptDlg'), form = $('promptForm'), field = $('promptField');
    $('promptTitle').textContent = title;
    $('promptBody').textContent = body; $('promptBody').style.display = body ? '' : 'none';
    $('promptFieldRow').style.display = value === null ? 'none' : '';
    field.value = value ?? '';
    field.required = value !== null;
    const btn = $('promptOk');
    btn.textContent = ok;
    btn.classList.toggle('danger', !!danger);
    let done = false;
    const finish = (v) => { if (done) return; done = true; cleanup(); resolve(v); };
    const onSubmit = (e) => { e.preventDefault(); dlg.close(); finish(value === null ? true : field.value.trim()); };
    const onClose = () => finish(null);
    function cleanup() { form.removeEventListener('submit', onSubmit); dlg.removeEventListener('close', onClose); }
    form.addEventListener('submit', onSubmit); dlg.addEventListener('close', onClose);
    dlg.showModal();
    if (value !== null) { field.focus(); field.select(); }
  });
}

// ---------------- toast ----------------
let toastTimer = null;
function toast(msg, bad = false) { const el = $('toast'); el.textContent = msg; el.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200); }

// ---------------- loop ----------------
const clock = new THREE.Clock();
let mmT = 0;
function loop() {
  const dt = Math.min(0.05, clock.getDelta());
  view.render(dt);
  mmT += dt; if (mmT > 0.25) { mmT = 0; view.drawMinimap(); }
  requestAnimationFrame(loop);
}
loop();
setTool('raise');
setInterval(() => setLive(live.connected), 2000);   // age out a headset that has gone quiet
// A serialized map is several hundred KB, far past the 64 KB cap that applies to BOTH
// sendBeacon and keepalive fetches, so there is no way to flush one on unload. Autosave
// quickly instead and warn if anything is still pending.
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
