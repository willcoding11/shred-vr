// Shred VR — game entry.
//
// This is a VR game and only a VR game. On a desktop browser you get a preview of the map you
// are editing and a button to put the headset on; you cannot ride, because the whole control
// scheme is "your two controllers are your two feet" and there is nothing to map that onto.
import * as THREE from 'three';
import { Terrain } from '../shared/terrain.js';
import { PropRenderer, makeStartGate, makeFinishBanner } from '../shared/props.js';
import { Scenery } from '../shared/scenery.js';
import { LiftRenderer, baseNear, seatAt, unloadSpot, LIFT } from '../shared/lifts.js';
import { LiveClient } from '../shared/live.js';
import { deserializeMap, applyRegion, PROP_TYPES, bounds, lowestHeight, heightAt } from '../shared/mapformat.js';
import { buildColliders, radiusAt, clears, bonk } from '../shared/collide.js';
import { Rider, SNOW } from './physics.js';
import { BoardControls } from './controls.js';
import { Hud, VrMenu, Vignette, fmtTime } from './hud.js';
import { GameAudio } from './audio.js';

const DEFAULTS = {
  regular: true, vignette: 0.6, realism: 'real', shadows: true, snowfall: true, legRate: 13, relief: 1, quality: 'fast',
  rollGain: 1.0, smoothing: 0.06, sound: true, pixelRatio: 1, boardLength: 1.5, slowMoScale: 0.35,
};
const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('shred.settings') || '{}') };
const saveSettings = () => localStorage.setItem('shred.settings', JSON.stringify(settings));
const $ = (id) => document.getElementById(id);

// ---------------- renderer / scene ----------------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * settings.pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = settings.shadows; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
const rig = new THREE.Group(); rig.name = 'rig'; rig.add(camera); scene.add(rig);
const scenery = new Scenery(scene, { shadows: settings.shadows, quality: settings.quality, renderer });
const vignette = new Vignette(camera);
const audio = new GameAudio();
const hud = new Hud();
const menu = new VrMenu();
scene.add(menu.dot);

const controls = new BoardControls(renderer, rig, {
  regular: settings.regular, rollGain: settings.rollGain, smoothing: settings.smoothing,
});
const xrControllers = [0, 1].map((i) => { const c = renderer.xr.getController(i); rig.add(c); return c; });

// ---------------- the board, drawn exactly where your feet put it ----------------
const boardGroup = new THREE.Group(); rig.add(boardGroup);
buildBoard(boardGroup, settings.boardLength);
const bootMarks = [0, 1].map(() => {
  const m = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.009, 8, 20),
    new THREE.MeshBasicMaterial({ color: 0x9ae6ff, transparent: true, opacity: 0.5, depthTest: false }));
  m.renderOrder = 40; m.visible = false; rig.add(m); return m;
});
const spray = makeSpray(); scene.add(spray.points);

// ---------------- state ----------------
let map = null, terrain = null, props = null, startGate = null, finishBanner = null, finishWidth = -1;
let rider = null;
let spatial = new Map();
let lifts = null, liftRide = null, liftDwell = 0;
let phase = 'idle';                 // idle (not in VR) | riding | finished
let runTime = 0, timerOn = false, checkpoint = null, best = null;
let flash = 0;
let inXR = false, mapsList = [], telemetryT = 0, propSyncT = 0, settleT = 0;
let prevX = 0, prevZ = 0;
let pointers = [];

const live = new LiveClient('game');

// ---------------- map ----------------
let loadSeq = 0;
const pinnedMap = new URL(location.href).searchParams.get('map') || null;
const rememberedMap = (location.hash.match(/map=([a-z0-9-]+)/) || [])[1] || null;

async function loadMapById(id, { keepPosition = false } = {}) {
  if (!id) return;
  const seq = ++loadSeq;
  let data;
  try { const res = await fetch(`/api/maps/${id}`); if (!res.ok) throw new Error('not found'); data = await res.json(); }
  catch { if (seq === loadSeq) setStatus(`Could not load map "${id}"`); return; }
  if (seq !== loadSeq) return;
  applyMap(deserializeMap(data), keepPosition);
}

function applyMap(m, keepPosition = false) {
  const same = map && map.id === m.id;
  map = m;
  if (!terrain) { terrain = new Terrain(map, { shadows: settings.shadows, relief: settings.relief, quality: settings.quality }); scene.add(terrain.mesh); }
  else terrain.setMap(map);
  if (!props) { props = new PropRenderer(map, { shadows: settings.shadows, quality: settings.quality }); scene.add(props.group); }
  else props.setMap(map);
  if (lifts) { scene.remove(lifts.group); lifts.dispose(); }
  lifts = new LiftRenderer(map, { shadows: settings.shadows });
  scene.add(lifts.group);
  rebuildMarkers(); rebuildSpatial();
  scenery.setEnv({ ...map.env, snowfall: settings.snowfall ? map.env.snowfall : 0 });
  terrain?.setSun(scenery.sunDir);   // the hill bakes its own sun shadows, so it has to know where the sun is
  scenery.setGround(lowestHeight(map), 0, ((map.size.h - 1) * map.spacing) / 2);
  if (!rider) rider = new Rider(terrain, { boardLength: settings.boardLength });
  rider.terrain = terrain;
  rider.snow = SNOW[map.env.snowType] || SNOW.groomed;
  applyRealism();
  if (!same || !keepPosition) { checkpoint = null; resetRun(); }
  $('mapName').textContent = map.name;
  $('mapDiff').textContent = map.difficulty; $('mapDiff').className = 'pill diff ' + map.difficulty;
  document.title = `${map.name} · Shred VR`;
  try { history.replaceState(null, '', `#map=${map.id}`); } catch {}
  best = Number(localStorage.getItem('shred.best.' + map.id)) || null;
  fillMapSelect();
  if (!inXR) framePreview();
}

// Rebuild the lift hardware in place. The rider may be sitting on a chair that is about to stop
// existing, so put them back on the snow first rather than leave them attached to nothing.
function rebuildLifts() {
  // Unload properly rather than just dropping the phase: unloadLift() puts you on the snow at the
  // top of the line you were on, which is where you were going anyway.
  if (phase === 'lift' && liftRide) unloadLift();
  if (lifts) { scene.remove(lifts.group); lifts.dispose(); }
  lifts = new LiftRenderer(map, { shadows: settings.shadows });
  scene.add(lifts.group);
}

// Everything that depends on the SHAPE of the ground rather than on one patch of it: the baked
// sun shadowing, the height of the valley floor, and the towers the lifts stand on. Doing this per
// brush dab would cost a re-bake of the whole heightfield every few milliseconds, so it settles
// once the stroke stops instead.
function settleTerrain() {
  if (!map || !terrain) return;
  terrain.setRails();                   // the boxes sit on ground that has just moved
  terrain.bakeLight();
  terrain.recolor();
  scenery.setGround(lowestHeight(map), 0, ((map.size.h - 1) * map.spacing) / 2);
  if (map.lifts && map.lifts.length) rebuildLifts();
  rebuildSpatial();
}

function rebuildMarkers() {
  if (!startGate) { startGate = makeStartGate(); scene.add(startGate); }
  placeOnGround(startGate, map.start.x, map.start.z, map.start.yaw || 0);
  startGate.visible = !map.freeride;
  if (!finishBanner || finishWidth !== map.finish.w) {
    if (finishBanner) { scene.remove(finishBanner); finishBanner.geometry.dispose(); finishBanner.material.dispose(); }
    finishBanner = makeFinishBanner(map.finish.w); finishWidth = map.finish.w; scene.add(finishBanner);
  }
  placeOnGround(finishBanner, map.finish.x, map.finish.z, map.finish.yaw || 0);
  finishBanner.visible = !map.freeride;
}
function placeOnGround(obj, x, z, yaw) { obj.position.set(x, terrain.heightAt(x, z), z); obj.rotation.y = yaw; obj.castShadow = true; }

function rebuildSpatial() {
  spatial = new Map();
  for (const o of buildColliders(map)) addSpatial(o);
}
function addSpatial(o) { const k = `${Math.floor(o.x / 8)},${Math.floor(o.z / 8)}`; (spatial.get(k) || spatial.set(k, []).get(k)).push(o); }
function nearby(x, z) {
  const cx = Math.floor(x / 8), cz = Math.floor(z / 8), out = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const l = spatial.get(`${cx + i},${cz + j}`); if (l) out.push(...l); }
  return out;
}
function applyRealism() {
  const easy = settings.realism === 'easy';
  // Nothing ends a run any more, so "easy" is not about surviving -- it is about how much the
  // board forgives. More grip, a wider window before the edge washes out, and a nose that
  // ploughs less when you get caught leaning forward.
  rider.t.muLatMax = easy ? 1.45 : 1.20;
  rider.t.slipPeakDeg = easy ? 9.0 : 5.5;
  rider.t.muLatFlat = easy ? 0.18 : 0.12;
  rider.t.noseDigScrub = easy ? 0.7 : 1.2;
}

// ---------------- chairlifts ----------------
// Stopping anywhere near a base station gets you scooped up, because hunting for a "board" button
// while standing in a lift queue is not what anyone wants to be doing.
function boardLift(line) {
  liftRide = { line, t: 0.004 };
  phase = 'lift';
  spray.emit(rider, 0);
  hud.message(line.name, 'Trigger skips you to the top', 4);
}

function stepLift(dtReal) {
  const L = liftRide;
  if (controls.pressed.trigger[0] || controls.pressed.trigger[1] || controls.pressed.a || controls.pressed.x) L.t = 1;
  else L.t += (LIFT.speed / L.line.len) * dtReal;
  if (L.t >= 1) { unloadLift(); return; }
  seatAt(L.line, L.t, tmpV);
  // Put your head where a seated person's head would be and let your feet -- and the board --
  // hang under the chair, which is what they do.
  rig.position.set(tmpV.x, tmpV.y + 0.78 - controls.head.pos.y, tmpV.z);
  rig.rotation.set(0, 0, 0);
  legY = null;
}

function unloadLift() {
  const line = liftRide.line; liftRide = null;
  const spot = unloadSpot(line, terrain);
  rider.reset(spot.x, spot.z, 0, controls.pose);
  legY = null; liftDwell = -2;             // do not get straight back on the one you just left
  phase = 'riding';
  hud.message('Top of ' + line.name, '', 2);
}

// ---------------- run control ----------------
function resetRun(toCheckpoint = false) {
  if (!map || !rider) return;
  const cp = toCheckpoint && checkpoint ? checkpoint : { x: map.start.x, z: map.start.z, yaw: map.start.yaw || 0 };
  rider.reset(cp.x, cp.z, cp.yaw, controls.pose);
  legY = null;
  prevX = cp.x; prevZ = cp.z;
  if (!toCheckpoint) { runTime = 0; timerOn = false; checkpoint = null; }
  phase = inXR ? 'riding' : 'idle';
  if (inXR) hud.message(toCheckpoint ? 'Back on your feet' : map.name, 'Point the nose downhill, or shove a dug-in edge to scoot off the mark', 4);
}

function finished() {
  phase = 'finished'; timerOn = false;
  audio.finish();
  const total = runTime;
  const isBest = best == null || total < best;
  if (isBest) { best = total; localStorage.setItem('shred.best.' + map.id, String(best)); }
  hud.message(`Finish ${fmtTime(total)}${isBest ? ' · New best!' : ''}`, '', 6);
}

// ---------------- live sync ----------------
live.on('welcome', (msg) => {
  mapsList = msg.maps || [];
  fillMapSelect();
  const want = pinnedMap || msg.active || map?.id || rememberedMap || mapsList[0]?.id;
  loadMapById(want, { keepPosition: want === map?.id });
  setLive(true);
});
live.on('close', () => setLive(false));
live.on('maps', (msg) => {
  mapsList = msg.maps;
  const me = map && mapsList.find((m) => m.id === map.id);
  if (me && me.name !== map.name) {
    map.name = me.name; map.difficulty = me.difficulty;
    $('mapName').textContent = map.name; document.title = `${map.name} · Shred VR`;
    $('mapDiff').textContent = map.difficulty; $('mapDiff').className = 'pill diff ' + map.difficulty;
  }
  fillMapSelect();
});
live.on('active', (msg) => {
  if (!msg.id || (map && map.id === msg.id)) return;
  if (pinnedMap && map) { setStatus(`Editor switched to "${msg.id}" — you are pinned to "${map.id}"`); return; }
  loadMapById(msg.id);
});
live.on('map', (msg) => { if (map && msg.map.id === map.id) { applyMap(deserializeMap(msg.map), true); flashLive(); } });
live.on('patch', (msg) => {
  if (!map || msg.id !== map.id) return;
  applyRegion(map, msg.rect, msg.heights);
  terrain.updateRegion(msg.rect);
  propSyncT = 0.25; settleT = 0.6; flashLive();
});
live.on('props', (msg) => {
  if (!map || msg.id !== map.id) return;
  map.props = msg.props; if (msg.start) map.start = msg.start; if (msg.finish) map.finish = msg.finish;
  if (msg.name) map.name = msg.name;
  if (msg.difficulty) map.difficulty = msg.difficulty;
  if (msg.freeride !== undefined) map.freeride = msg.freeride;
  if (msg.dropIns !== undefined) map.dropIns = msg.dropIns;
  // Ice is a terrain COLOUR, so changing it has to repaint the hill rather than the props.
  const iceBefore = JSON.stringify(map.ice ?? null);
  if (msg.ice !== undefined) map.ice = msg.ice;
  if (msg.tarn !== undefined) map.tarn = msg.tarn;
  // Lifts are hardware: rebuilding them is a new set of towers, cable and chairs, so only do it
  // when they have actually changed.
  if (msg.lifts !== undefined && JSON.stringify(msg.lifts) !== JSON.stringify(map.lifts || [])) {
    map.lifts = msg.lifts;
    rebuildLifts();
  }
  terrain.setRails();                 // a rail is a surface, so a new one changes the ground
  props.sync(); rebuildMarkers(); rebuildSpatial();
  if (JSON.stringify(map.ice ?? null) !== iceBefore) terrain.recolor();
  flashLive();
});
live.on('env', (msg) => {
  if (!map || msg.id !== map.id) return;
  map.env = { ...map.env, ...msg.env };
  scenery.setEnv({ ...map.env, snowfall: settings.snowfall ? map.env.snowfall : 0 });
  terrain?.setSun(scenery.sunDir);   // the hill bakes its own sun shadows, so it has to know where the sun is
  scenery.setGround(lowestHeight(map), 0, ((map.size.h - 1) * map.spacing) / 2);
  rider.snow = SNOW[map.env.snowType] || SNOW.groomed;
  terrain.recolor(); flashLive();
});

// ---------------- page UI ----------------
function setStatus(t) { $('status').textContent = t; }
function setLive(on) { $('live').className = 'pill live ' + (on ? 'on' : 'off'); $('live').textContent = on ? 'Live' : 'Reconnecting'; }
function flashLive() { $('live').classList.add('flash'); setTimeout(() => $('live').classList.remove('flash'), 400); }
function fillMapSelect() {
  const sel = $('mapSelect'); sel.innerHTML = '';
  for (const m of mapsList) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; sel.appendChild(o); }
  if (map) sel.value = map.id;
}
$('mapSelect').addEventListener('change', (e) => { loadMapById(e.target.value); live.send({ type: 'active', id: e.target.value }); });
$('btnRestart').addEventListener('click', () => resetRun());
$('btnSettings').addEventListener('click', () => $('settings').classList.toggle('open'));
$('btnCloseSettings').addEventListener('click', () => $('settings').classList.remove('open'));
$('btnHelp').addEventListener('click', () => $('help').classList.toggle('open'));
$('btnCloseHelp').addEventListener('click', () => $('help').classList.remove('open'));

bindSetting('setStance', 'regular', (v) => v === 'regular', (v) => (v ? 'regular' : 'goofy'), () => { controls.settings.regular = settings.regular; });
bindSetting('setRealism', 'realism', (v) => v, (v) => v, () => rider && applyRealism());
bindSetting('setVignette', 'vignette', Number, String);
bindSetting('setRoll', 'rollGain', Number, String, () => { controls.settings.rollGain = settings.rollGain; });
bindSetting('setSmoothing', 'smoothing', Number, String, () => { controls.settings.smoothing = settings.smoothing; });
bindSetting('setBoardLen', 'boardLength', Number, String, () => {
  if (rider) rider.t.boardLength = settings.boardLength;
  boardGroup.clear(); buildBoard(boardGroup, settings.boardLength);
});
bindSetting('setShadows', 'shadows', (v) => v === 'on', (v) => (v ? 'on' : 'off'), () => { renderer.shadowMap.enabled = settings.shadows; scenery.sun.castShadow = settings.shadows; });
bindSetting('setSnowfall', 'snowfall', (v) => v === 'on', (v) => (v ? 'on' : 'off'), () => map && scenery.setEnv({ snowfall: settings.snowfall ? map.env.snowfall : 0 }));
bindSetting('setSound', 'sound', (v) => v === 'on', (v) => (v ? 'on' : 'off'), () => { audio.enabled = settings.sound; if (audio.master) audio.master.gain.value = settings.sound ? 0.8 : 0; });
bindSetting('setSlowMo', 'slowMoScale', Number, String);
bindSetting('setLegs', 'legRate', Number, String);
bindSetting('setRelief', 'relief', Number, String, () => { if (terrain) { terrain.relief = settings.relief; terrain.recolor(); } });
bindSetting('setQuality', 'quality', (v) => v, (v) => v, applyQuality);

// The "Real" preset. Appearance only: nothing here is readable by the physics, and the board
// behaves identically either way. It costs a filmic tone curve, a scattering sky, a snow shader
// that sparkles and scatters under its own surface, denser trees and a bigger shadow map.
function applyQuality() {
  const real = settings.quality === 'real';
  // ACES on BOTH. Turning it off for Fast clipped highlights harder than the game did before this
  // setting existed, which made choosing "Fast" a regression. And 1.35 on Real was not realism,
  // it was the brightness turned up: it blew the piste to featureless white and the Fast image
  // had more tonal shape in the snow than the Real one did.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = real ? 1.0 : 0.95;
  scenery.setQuality(settings.quality);
  if (terrain) {
    scene.remove(terrain.mesh); terrain.dispose();
    terrain = new Terrain(map, { shadows: settings.shadows, relief: settings.relief, quality: settings.quality });
    terrain.setSun(scenery.sunDir);
    scene.add(terrain.mesh);
    if (rider) rider.terrain = terrain;
  }
  if (props) {
    scene.remove(props.group);
    props = new PropRenderer(map, { shadows: settings.shadows, quality: settings.quality });
    scene.add(props.group);
  }
}
bindSetting('setPixel', 'pixelRatio', Number, String, applyRenderScale);
function applyRenderScale() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * settings.pixelRatio);
  renderer.xr.setFramebufferScaleFactor?.(Math.max(0.5, Math.min(1.5, settings.pixelRatio)));
}
function bindSetting(id, key, parse, format, after) {
  const el = $(id); if (!el) return;
  el.value = format(settings[key]);
  const out = el.parentElement.querySelector('output'); if (out) out.textContent = el.value;
  const apply = () => { settings[key] = parse(el.value); if (out) out.textContent = el.value; saveSettings(); after && after(); };
  el.addEventListener('input', apply);
  el.addEventListener('change', apply);
  after && after();
}

// ---------------- XR ----------------
async function enterVR() {
  if (!navigator.xr) { setStatus('This browser has no WebXR. Open the page on the headset.'); return; }
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    session.addEventListener('end', () => {
      inXR = false; phase = 'idle';
      $('vrBtn').textContent = 'Enter VR'; document.body.classList.remove('xr');
      hud.mesh.visible = false; menu.show(false);
      calibrated = false; sawHands = 0;        // re-arm auto-calibration for the next session
      for (const b of bootMarks) b.visible = false;
      for (const p of pointers) p.parent?.remove(p);
      pointers = [];
      framePreview();
    });
    await renderer.xr.setSession(session);
    inXR = true;
    document.body.classList.add('xr');
    audio.ensure();
    rig.add(hud.mesh); hud.mesh.visible = true;
    for (const p of pointers) p.parent?.remove(p);
    pointers = xrControllers.map((c) => { const p = menu.pointer.clone(); p.visible = false; c.add(p); return p; });
    resetRun();
  } catch (e) { setStatus('Could not start VR: ' + e.message); }
}
$('onboardGo').addEventListener('click', () => {
  $('onboard').hidden = true; localStorage.setItem('shred.onboarded', '1'); enterVR();
});
$('vrBtn').addEventListener('click', () => {
  if (!localStorage.getItem('shred.onboarded')) { $('onboard').hidden = false; return; }
  enterVR();
});
if (navigator.xr) navigator.xr.isSessionSupported('immersive-vr').then((ok) => { if (!ok) markNoVr(); });
else markNoVr();
function markNoVr() {
  const b = $('vrBtn');
  b.classList.add('disabled'); b.textContent = 'No VR here';
  b.title = 'Open this page on the headset to ride';
  $('status').textContent = 'This is a VR game. Open it on the headset to ride — this page is only a preview of the map.';
}

// ---------------- VR menu ----------------
const MENU_ITEMS = () => [
  { id: 'restart', label: 'Restart run' },
  { id: 'recal', label: 'Recalibrate: hold the board flat' },
  { id: 'hud', label: 'Recentre the display' },
  { id: 'next', label: 'Next map', value: map ? map.name : '' },
  { id: 'stance', label: 'Stance', value: settings.regular ? 'Regular (left foot forward)' : 'Goofy (right foot forward)' },
  { id: 'realism', label: 'Realism', value: settings.realism === 'easy' ? 'Easy' : 'Real' },
  { id: 'vignette', label: 'Comfort vignette', value: settings.vignette === 0 ? 'Off' : settings.vignette < 0.5 ? 'Low' : 'High' },
  { id: 'close', label: 'Close' },
];
function faceViewer(mesh) {
  rig.updateMatrixWorld(true);
  mesh.lookAt(rig.localToWorld(controls.head.pos.clone()));
}
function placeHud() {
  const fwd = controls.head.fwd.clone(); if (fwd.lengthSq() < 0.01) fwd.set(0, 0, -1);
  const p = controls.head.pos.clone().addScaledVector(fwd, 1.3);
  p.y = controls.head.pos.y - 0.5;
  hud.mesh.position.copy(p);
  faceViewer(hud.mesh);
}
function openMenu() {
  menu.setItems(MENU_ITEMS(), 'Shred VR');
  const fwd = controls.head.fwd.clone(); if (fwd.lengthSq() < 0.01) fwd.set(0, 0, -1);
  const pos = controls.head.pos.clone().addScaledVector(fwd, 1.5); pos.y = controls.head.pos.y - 0.1;
  rig.add(menu.mesh);
  menu.mesh.position.copy(pos);
  faceViewer(menu.mesh);
  menu.beamLength = 3;
  menu.show(true);
}
function menuAction(id) {
  switch (id) {
    case 'restart': menu.show(false); resetRun(); break;
    case 'recal': menu.show(false); if (controls.calibrate()) { placeHud(); hud.message('Calibrated', 'That pose is now "board flat"', 1.6); } break;
    case 'hud': menu.show(false); placeHud(); break;
    case 'next': { const i = mapsList.findIndex((m) => m.id === map.id); const n = mapsList[(i + 1) % mapsList.length]; if (n) { loadMapById(n.id); live.send({ type: 'active', id: n.id }); } menu.setItems(MENU_ITEMS()); break; }
    case 'stance': settings.regular = !settings.regular; saveSettings(); controls.settings.regular = settings.regular; $('setStance').value = settings.regular ? 'regular' : 'goofy'; menu.setItems(MENU_ITEMS()); break;
    case 'realism': settings.realism = settings.realism === 'easy' ? 'real' : 'easy'; saveSettings(); applyRealism(); $('setRealism').value = settings.realism; menu.setItems(MENU_ITEMS()); break;
    case 'vignette': settings.vignette = settings.vignette === 0 ? 0.35 : settings.vignette < 0.5 ? 0.8 : 0; saveSettings(); $('setVignette').value = settings.vignette; menu.setItems(MENU_ITEMS()); break;
    case 'close': menu.show(false); break;
  }
}

// ---------------- loop ----------------
const clock = new THREE.Clock();
const FIXED = 1 / 120;
let acc = 0, calibrated = false, sawHands = 0, slowMo = 1, legY = null, legVy = 0, bootSag = 0, onRail = 0;
let lastGateTap = 0;
const BOOT_AXIS = new THREE.Vector3(0, 0, 1);
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), _basis = new THREE.Matrix4();
const preview = { angle: 0, drag: false, lastX: 0, lastY: 0, yaw: 0.6, pitch: 0.42, dist: 70 };

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  const now = performance.now();
  if (!map) { renderer.render(scene, camera); return; }

  if (inXR) stepVR(dt, now);
  else stepPreview(dt);

  spray.update(dt);
  flash = Math.max(0, flash - dt * 1.5);
  if (propSyncT > 0) { propSyncT -= dt; if (propSyncT <= 0) { props.sync(); rebuildMarkers(); } }
  if (settleT > 0) { settleT -= dt; if (settleT <= 0) settleTerrain(); }


  // the snow shader needs to know where the sun is, or its sparkle and its blue shadows point
  // somewhere the light is not
  const su = terrain?.material?.userData?.realUniforms;
  if (su && scenery.sunDir) su.uSunDir.value.copy(scenery.sunDir);
  camera.getWorldPosition(tmpV);
  if (lifts) lifts.update(dt, inXR && rider ? rider.boardPos : tmpV);
  // Which terrain tiles draw, and at what detail. Keyed off the viewer rather than the camera,
  // because in XR the camera three.js actually renders with is not this one.
  terrain?.update(inXR && rider ? rider.boardPos : tmpV);
  props?.cull(inXR && rider ? rider.boardPos : tmpV);
  scenery.update(dt, inXR ? rider.boardPos : tmpV, { position: tmpV });
  renderer.render(scene, camera);
});

function stepVR(dtReal, now) {
  const pose = controls.update(dtReal, camera);

  // Slow motion, held on either grip. Slowp leans on this constantly and it is the single
  // thing that makes a hand-driven trick landable, so the clock keeps running in real time:
  // it buys you control, not a better result.
  const wantSlow = (controls.buttons.grip[0] || controls.buttons.grip[1]) ? settings.slowMoScale : 1;
  slowMo += (wantSlow - slowMo) * Math.min(1, dtReal * 12);
  const dt = dtReal * slowMo;

  // Calibrate once, automatically, as soon as both hands are seen: whatever you are holding
  // becomes "board flat". No button to press before you can ride.
  if (pose.valid) sawHands += dt; else sawHands = 0;
  if (!calibrated && sawHands > 0.6) { calibrated = controls.calibrate(); if (calibrated) { placeHud(); hud.message('Ready', 'That pose is "board flat". Shove the board back to set off.', 4); } }

  // buttons
  if (controls.pressed.b || controls.pressed.y) { if (menu.visible) menu.show(false); else openMenu(); }
  for (const p of pointers) p.visible = menu.visible;
  if (menu.visible) {
    for (let i = 0; i < 2; i++) {
      const c = xrControllers[i];
      c.getWorldPosition(tmpV); c.getWorldDirection(tmpV2); tmpV2.negate();
      const hit = menu.point(tmpV, tmpV2, controls.pressed.trigger[i]);
      for (const p of pointers) p.scale.z = menu.beamLength || 3;
      if (hit) { menuAction(hit); break; }
    }
  } else {
    if (controls.pressed.trigger[0] || controls.pressed.trigger[1]) { if (controls.calibrate()) { calibrated = true; placeHud(); hud.message('Calibrated', '', 1.2); } }
    if (controls.pressed.a || controls.pressed.x) {
      // tap once to go back to the start, twice quickly to reset the clock too
      if (now - lastGateTap < 500) { resetRun(); lastGateTap = 0; }
      else { resetRun(true); lastGateTap = now; }
    }
  }
  for (let i = 0; i < 2; i++) {
    const h = controls.hands[i];
    bootMarks[i].visible = !!h && phase === 'riding';
    if (h) {
      bootMarks[i].position.copy(h.pos);
      bootMarks[i].position.y += bootSag;      // travel with the board, or your feet leave it
      bootMarks[i].quaternion.setFromUnitVectors(BOOT_AXIS, controls.pose.up);
    }
  }

  if (phase === 'lift') { stepLift(dtReal); }

  // physics
  if (phase === 'riding' || phase === 'finished') {
    hitThisFrame = false;
    acc += dt;
    let steps = 0;
    while (acc >= FIXED && steps < 8) {
      // Hand velocity goes in UNSCALED, and that is what makes slow motion neutral. It is
      // measured in metres per real second and the physics consumes it as metres per game
      // second, so the same real hand movement produces the same push either way. Scaling it
      // by the time factor as well squared the slowdown and quietly deleted jumping: a drive
      // worth 0.37 m of air at full speed was worth 0.03 m with the grip held.
      rider.step(FIXED, pose, controls.handVel, tuckAmount(), controls.head.pos);
      acc -= FIXED; steps++;
      handleEvents();
      if (phase === 'riding') { checkCollisions(); if (phase !== 'riding') break; }
    }
    if (phase === 'riding' || phase === 'finished') checkBounds();
    if (phase === 'riding' && !map.freeride && prevZ < map.finish.z && rider.boardPos.z >= map.finish.z) finished();
    if (!map.freeride) {
      if (!timerOn && rider.speed > 1 && rider.boardPos.z > map.start.z + 4) timerOn = true;
      if (timerOn && phase === 'riding') runTime += dtReal;
    }
    // Stop near a base station and a chair picks you up.
    if (phase === 'riding' && lifts && lifts.lines.length) {
      if (rider.speed < 3.2 && baseNear(lifts.lines, rider.boardPos.x, rider.boardPos.z)) liftDwell += dtReal;
      else liftDwell = Math.min(0, liftDwell);
      if (liftDwell > 0.5) { liftDwell = 0; boardLift(baseNear(lifts.lines, rider.boardPos.x, rider.boardPos.z)); }
    }
    prevX = rider.boardPos.x; prevZ = rider.boardPos.z;
    spray.emit(rider, dt);
    if (liftDwell < 0) liftDwell = Math.min(0, liftDwell + dtReal);
  }

  // the rig IS the rider; the board is drawn where the hands are
  // The rig NEVER rotates. Your heading is your body's heading, in the room, and a turn is
  // something you make by physically swinging the board round. Nothing spins the world for you.
  if (phase !== 'lift') { rig.position.copy(rider.pos); rig.rotation.set(0, 0, 0); }

  // Legs. The heightfield is bilinear on a 2 m grid, so it has a crease at every grid line, and
  // a rigid rider delivers one of those straight into the player's head several times a second.
  // The physics stays rigid; this is a bounded view offset.
  //
  // It has to track the descent before it can filter the bumps. A plain low-pass of the absolute
  // height is always chasing a rider dropping at v*sin(slope), so it sits at a fixed lag -- on a
  // real map that is 40 cm of lag clamped to the limit, which is a permanent offset that filters
  // nothing at all. Carrying the current vertical velocity forward first makes the lag zero for
  // any steady descent, so what is left to filter is exactly the bumps.
  // Carrying the descent forward has to use a SMOOTHED vertical velocity. The raw one jumps
  // every time the contact resolves, so feeding it in unfiltered pipes exactly the noise this
  // is meant to remove straight into the view -- and the faster you go, the more of it there is.
  if (legY === null) { legY = rider.pos.y; legVy = rider.vel.y; }
  legVy += (rider.vel.y - legVy) * Math.min(1, dtReal * 7);
  if (phase === 'lift') { legY = rider.pos.y; legVy = 0; }
  legY += legVy * dtReal;
  const rate = rider.grounded && !rider.standing ? settings.legRate : 30;
  legY += (rider.pos.y - legY) * Math.min(1, dtReal * rate);
  // The suspension needs more travel the faster you go, for the same reason your knees do.
  const travel = 0.09 + Math.min(0.10, rider.speed * 0.005);
  const sag = THREE.MathUtils.clamp(rider.pos.y - legY, -travel, travel);
  legY = rider.pos.y - sag;
  if (phase !== 'lift') rig.position.y = rider.pos.y - sag;
  bootSag = phase === 'lift' ? 0 : sag;

  // DRAW from the unsmoothed pose. The physics reads the smoothed one, because a 60 ms filter
  // is what keeps tracking noise out of the forces, but drawing through that same filter puts
  // 60 ms between your hands and the board you can see. That lag is most of what reads as
  // "floaty" in a headset, and it costs nothing to remove.
  const draw = controls.rawPose.valid ? controls.rawPose : pose;
  if (draw.valid) {
    boardGroup.visible = true;
    boardGroup.position.copy(draw.center);
    if (phase !== 'lift') boardGroup.position.y += sag;   // ...so the board is still on the snow
    const side = tmpV.crossVectors(draw.up, draw.nose).normalize();
    boardGroup.quaternion.setFromRotationMatrix(_basis.makeBasis(side, draw.up, draw.nose));
  } else boardGroup.visible = false;

  // Nothing rotates the world any more, so the only thing left to soften is the load in a
  // hard carve. That is real acceleration you can feel, not induced vection.
  vignette.update(dt, Math.min(1, settings.vignette * THREE.MathUtils.clamp(Math.abs(rider.lateralG) / 2.6, 0, 1) + flash * 0.9));

  // Are we on a box? The terrain already knows, because a rail IS its surface there.
  const railNow = rider.grounded && terrain.hasRails()
    && terrain.railAt(rider.boardPos.x, rider.boardPos.z) > heightAt(map, rider.boardPos.x, rider.boardPos.z) ? 1 : 0;
  if (railNow !== onRail) { if (railNow) audio.railOn(); else audio.railOff(); onRail = railNow; }
  audio.update(dtReal, { speed: rider.speed * slowMo, carving: rider.carving, skidding: rider.skidding, grounded: rider.grounded, tuck: tuckAmount(), onRail });
  const st = hudState();
  st.slow = slowMo < 0.9;
  hud.update(st, now);
  updateDomHud(st);

  telemetryT += dt;
  if (telemetryT > 0.12) {
    telemetryT = 0;
    live.send({ type: 'telemetry', id: map.id, x: +rider.boardPos.x.toFixed(2), z: +rider.boardPos.z.toFixed(2), yaw: +Math.atan2(rider.vel.x, rider.vel.z).toFixed(3), speed: +rider.speed.toFixed(1), phase });
  }
}

// Desktop: a slow look around the map you are editing. No riding, by design.
function stepPreview(dt) {
  if (preview.spin !== false) preview.angle += dt * 0.06;
  const s = preview.at || map.start;
  const y = terrain.heightAt(s.x, s.z);
  const yaw = preview.yaw + preview.angle, pitch = preview.pitch;
  rig.position.set(
    s.x + Math.sin(yaw) * Math.cos(pitch) * preview.dist,
    y + Math.sin(pitch) * preview.dist,
    s.z + Math.cos(yaw) * Math.cos(pitch) * preview.dist - 40,
  );
  rig.rotation.set(0, 0, 0);
  camera.position.set(0, 0, 0);
  camera.lookAt(s.x, y + (preview.aim ?? 4), s.z + (preview.ahead ?? 45));
  boardGroup.visible = false;
  for (const b of bootMarks) b.visible = false;
  updateDomHud(hudState());
}
function framePreview() { preview.angle = 0; }

// Look at a map from somewhere the orbit does not reach. Desktop preview only, and it is here
// because reviewing a mountain from one fixed circle around the start tells you almost nothing
// about it. Call from the console: shredCam({ at:{x,z}, dist, yaw, pitch, spin:false }).
window.shredCam = (o = {}) => { Object.assign(preview, o); if (o.at === null) preview.at = null; return preview; };
// Everything a review needs to check a claim instead of squinting at a screenshot. Reviewing the
// Real preset from pictures alone kept producing confident statements about which mesh or which
// shadow map was in use that turned out to be wrong in both directions.
window.shredRefs = () => ({ scene, renderer, scenery, terrain, props, lifts, settings, live, map, nearby, groundAt: heightAt });

// A repeatable cost measurement, because "it looks smooth on a desktop GPU" is not a number and a
// headset has about eleven milliseconds for two eyes. Walks a fixed set of viewpoints, lets the
// tile and prop culling settle, and reports what the frame actually cost at each one.
// Run from the console on the desktop preview:  await shredPerf()
window.shredPerf = (points) => {
  const pts = points || [
    { name: 'start gate',           x: 225,  z: 120, dist: 5,   pitch: 0.10, ahead: 80 },
    { name: 'summit, looking down', x: 210,  z: 95,  dist: 40,  pitch: 0.26, ahead: 200 },
    { name: 'upper bowl',           x: 300,  z: 300, dist: 6,   pitch: 0.10, ahead: 90 },
    { name: 'mid mountain',         x: 0,    z: 470, dist: 6,   pitch: 0.10, ahead: 90 },
    { name: 'in the gully',         x: -160, z: 520, dist: 5,   pitch: 0.08, ahead: 60 },
    { name: 'in the trees',         x: -306, z: 818, dist: 5,   pitch: 0.08, ahead: 50 },
    { name: 'village',              x: 0,    z: 880, dist: 6,   pitch: 0.12, ahead: 80 },
    { name: 'whole hill',           x: 0,    z: 600, dist: 260, pitch: 0.34, ahead: 260 },
  ];
  const keep = { ...preview };
  const out = [];
  // Frames are driven straight through the renderer rather than waited for. A hidden tab does not
  // run requestAnimationFrame, and a measurement that only works when someone is watching is not
  // a measurement.
  for (const p of pts) {
    Object.assign(preview, { at: { x: p.x, z: p.z }, dist: p.dist ?? 6, yaw: p.yaw ?? 0,
      pitch: p.pitch ?? 0.12, spin: false, angle: 0, aim: p.aim ?? 1.4, ahead: p.ahead ?? 60 });
    let draws = 0, tris = 0;
    for (let i = 0; i < 3; i++) {
      stepPreview(0.016);
      camera.getWorldPosition(tmpV);
      terrain?.update(tmpV);
      props?.cull(tmpV, true);
      renderer.render(scene, camera);
      draws = renderer.info.render.calls; tris = renderer.info.render.triangles;
    }
    out.push({ where: p.name, draws, tris });
  }
  Object.assign(preview, keep);
  console.table(out);
  return out;
};
window.shredDebug = () => ({
  quality: settings.quality, shadows: settings.shadows,
  tone: renderer.toneMapping, exposure: renderer.toneMappingExposure,
  shadowMap: scenery.sun.shadow?.mapSize?.toArray(),
  env: !!scene.environment, envIntensity: scene.environmentIntensity,
  sun: scenery.sunDir && [+scenery.sunDir.x.toFixed(3), +scenery.sunDir.y.toFixed(3), +scenery.sunDir.z.toFixed(3)],
  fog: [scene.fog?.near, scene.fog?.far],
  terrainCastShadow: terrain?.mesh.castShadow,
  bake: terrain?.bake ? (() => { let lo = 1, hi = 0, sum = 0; for (const v of terrain.bake) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
    return { min: +lo.toFixed(3), max: +hi.toFixed(3), mean: +(sum / terrain.bake.length).toFixed(3) }; })() : null,
  propMeshes: props ? props.group.children.map((m) => `${m.name}x${m.count}`) : [],
  mountainsPinned: scenery.mountains?.userData.pinned,
  // what the last frame actually cost
  draws: renderer.info.render.calls, tris: renderer.info.render.triangles,
  settleT: +settleT.toFixed(3), propSyncT: +propSyncT.toFixed(3),
  chunks: terrain ? (() => {
    let vis = 0; const lod = [0, 0, 0, 0];
    for (const c of terrain.chunks) if (c.mesh.visible) { vis++; lod[c.lod]++; }
    return { total: terrain.chunks.length, visible: vis, lod };
  })() : null,
});
canvas.addEventListener('pointerdown', (e) => { if (!inXR) { preview.drag = true; preview.lastX = e.clientX; preview.lastY = e.clientY; } });
window.addEventListener('pointerup', () => { preview.drag = false; });
window.addEventListener('pointermove', (e) => {
  if (!preview.drag || inXR) return;
  preview.yaw -= (e.clientX - preview.lastX) * 0.005;
  preview.pitch = THREE.MathUtils.clamp(preview.pitch - (e.clientY - preview.lastY) * 0.004, 0.06, 1.3);
  preview.lastX = e.clientX; preview.lastY = e.clientY;
});
canvas.addEventListener('wheel', (e) => { if (!inXR) { preview.dist = THREE.MathUtils.clamp(preview.dist * (1 + Math.sign(e.deltaY) * 0.1), 12, 400); e.preventDefault(); } }, { passive: false });

// How tucked you are: the gap between your head and the board. Standing tall is ~1.5 m,
// folded over the board is ~0.7 m, and that difference is worth real drag.
// How tucked you are, from the gap between your head and the board.
//
// The range has to match THIS game's geometry. The board sits at hand height, so riding normally
// already puts your head only about 0.75 m above it -- against the old 1.35 m reference that
// pinned the reading at fully tucked and never moved, which meant the drag never changed and
// there was nothing to gain by getting low. Standing tall with your hands down is about 0.95 m;
// folded over the board is about 0.55.
function tuckAmount() {
  if (!controls.pose.valid) return 0;
  const gap = controls.head.pos.y - controls.pose.center.y;
  return THREE.MathUtils.clamp((1.00 - gap) / 0.35, 0, 1);
}

function hudState() {
  return {
    speed: rider ? rider.speed : 0, time: runTime,
    edge: rider ? rider.edgeDeg : 0, g: rider ? rider.lateralG : 0,
    air: rider && !rider.grounded ? rider.airTime : 0, best, slow: false,
  };
}

function handleEvents() {
  const ev = rider.lastEvent; if (!ev) return;
  if (ev.type === 'land') { audio.land(ev.impact); if (ev.air > 0.8) hud.message(`${ev.air.toFixed(1)}s air`, '', 1.2); }
  else if (ev.type === 'pop') audio.jump();
}

let hitThisFrame = false;
function checkCollisions() {
  const p = rider.boardPos;
  const easy = settings.realism === 'easy';
  for (const o of nearby(p.x, p.z)) {
    // OVER IT IS PAST IT, and a conifer is a spike rather than a pillar -- see collide.js.
    if (clears(o, p.y)) continue;
    const rad = radiusAt(o, p.y);
    const d = Math.hypot(o.x - p.x, o.z - p.z);
    if (d >= rad + 0.28) continue;
    const nx = (p.x - o.x) / (d || 1), nz = (p.z - o.z) / (d || 1);
    if (o.hard) {
      rider.pos.x += nx * (rad + 0.35 - d); rider.pos.z += nz * (rad + 0.35 - d);
      // At most one response per frame, whatever you clipped. Remembering a single last-hit
      // object is not enough: a fence is built from nine overlapping spheres 0.75 m apart, so you
      // are inside two or three at once, the guard never matches, and the brake compounds once
      // per sphere per substep. Measured, riding into one fence at 15 m/s left the rider at
      // 4.8e-110 m/s -- total annihilation, which then dropped them in a heap on the hill.
      if (hitThisFrame) continue;
      hitThisFrame = true;
      if (easy) {
        // A BONK. You lose a little speed and get steered round it, rather than stopped dead.
        const r2 = bonk(rider.vel.x, rider.vel.z, nx, nz);
        rider.vel.x = r2.vx; rider.vel.z = r2.vz;
        if (rider.speed > 4) audio.stumble();
      } else {
        // Solid, so it stops you dead and shoves you clear. It does not end the run -- you just
        // have to get going again, which costs you far more than a reset screen would.
        if (rider.speed > 3.5) audio.crash();
        rider.vel.multiplyScalar(0.12);
      }
    } else {
      rider.pos.x += nx * (rad + 0.3 - d); rider.pos.z += nz * (rad + 0.3 - d);
      rider.vel.multiplyScalar(o.t === 'pole' ? 0.85 : 0.6);
      audio.stumble();
    }
  }
}

function checkBounds() {
  const b = bounds(map), p = rider.boardPos, m = 2.5;
  if (p.x < b.minX + m) { rider.pos.x += (b.minX + m) - p.x; rider.vel.x = Math.abs(rider.vel.x) * 0.3; }
  if (p.x > b.maxX - m) { rider.pos.x -= p.x - (b.maxX - m); rider.vel.x = -Math.abs(rider.vel.x) * 0.3; }
  if (p.z < b.minZ + 1) { rider.pos.z += (b.minZ + 1) - p.z; rider.vel.z = Math.abs(rider.vel.z) * 0.3; }
  if (p.z > b.maxZ - m) {
    // An open hill has no end to fall off: you get pushed back in, like every other edge.
    if (map.freeride || phase === 'finished') { rider.pos.z -= p.z - (b.maxZ - m); rider.vel.z = -Math.abs(rider.vel.z) * 0.3; return; }
    hud.message('End of the run', '', 1.5); resetRun();
  }
}

function updateDomHud(s) {
  $('speed').textContent = Math.round(s.speed * 3.6);
  $('time').textContent = fmtTime(s.time);
  const e = Math.max(-1, Math.min(1, s.edge / 60));
  $('edgeFill').style.left = e < 0 ? `${50 + e * 50}%` : '50%';
  $('edgeFill').style.width = `${Math.abs(e) * 50}%`;
  $('edgeFill').className = 'edge-fill ' + (e > 0 ? 'toe' : 'heel');
  $('gforce').textContent = `${Math.abs(s.g).toFixed(1)} g`;
  $('air').textContent = s.slow ? 'slow-mo' : s.air > 0.15 ? `air ${s.air.toFixed(1)}s` : '';
  $('best').textContent = s.best != null ? `best ${fmtTime(s.best)}` : '';
  if (hud.msg && performance.now() < hud.msgUntil) { $('msg').textContent = hud.msg; $('msgSub').textContent = hud.sub; $('msgWrap').classList.add('show'); }
  else $('msgWrap').classList.remove('show');
}

// ---------------- board mesh ----------------
// The board. It is forty centimetres from your face for the entire game, so it is the one object
// worth spending geometry on -- and it was a flat plank: no kick, no camber, no sidecut, a steel
// edge made from a box that stuck out past the corners, the topsheet graphic mirrored onto the
// base, and bindings that were two cubes.
//
// It is built here as a lofted surface: a length-wise profile that carries camber and kicked tip
// and tail, crossed with a width profile that carries the sidecut. Everything else hangs off that.
function buildBoard(group, length = 1.5) {
  const L = length, WAIST = 0.248, TIP = 0.292, THICK = 0.0085;
  const NOSE = 0.155, KICK = 0.055, CAMBER = 0.008;
  const NZ = 34, NX = 9;                                    // sections along, points across

  // half-width at t in -1..1 (tail..nose): sidecut through the middle, rounded off at the ends
  const halfW = (t) => {
    const a = Math.abs(t);
    const contact = 1 - NOSE * 2 / L;
    if (a <= contact) return (WAIST + (TIP - WAIST) * Math.pow(a / contact, 2)) / 2;
    const u = (a - contact) / (1 - contact);
    return (TIP / 2) * Math.sqrt(Math.max(0, 1 - u * u * 0.94));
  };
  // base height at t: camber in the middle, kick at both ends. This is the silhouette.
  const baseY = (t) => {
    const a = Math.abs(t);
    const contact = 1 - NOSE * 2 / L;
    if (a <= contact) return CAMBER * (1 - Math.pow(a / contact, 2));
    const u = (a - contact) / (1 - contact);
    return KICK * u * u;
  };

  const pos = [], nrm = [], uvs = [], idx = [];
  const push = (x, y, z, u, v) => { pos.push(x, y, z); uvs.push(u, v); };
  // two surfaces: base (down) and deck (up), joined at the rim
  for (let s2 = 0; s2 < 2; s2++) {
    const top = s2 === 1;
    for (let i2 = 0; i2 <= NZ; i2++) {
      const t = (i2 / NZ) * 2 - 1, z = t * L / 2, hw = halfW(t), y0 = baseY(t);
      // the deck thins toward the tip and tail, the way a real board does
      const th = THICK * (0.45 + 0.55 * Math.pow(1 - Math.abs(t), 0.5));
      for (let k = 0; k <= NX; k++) {
        const f = (k / NX) * 2 - 1;
        const x = f * hw;
        const dome = top ? th * (1 - f * f * 0.35) : 0;
        push(x, y0 + dome, z, f * 0.5 + 0.5, i2 / NZ);
      }
    }
  }
  const ring = NX + 1, sheet = (NZ + 1) * ring;
  for (let s2 = 0; s2 < 2; s2++) for (let i2 = 0; i2 < NZ; i2++) for (let k = 0; k < NX; k++) {
    const o = s2 * sheet + i2 * ring + k;
    if (s2 === 1) idx.push(o, o + 1, o + ring, o + 1, o + ring + 1, o + ring);
    else idx.push(o, o + ring, o + 1, o + 1, o + ring, o + ring + 1);
  }
  // the rim, closing base to deck down both sides
  for (let i2 = 0; i2 < NZ; i2++) for (const k of [0, NX]) {
    const b = i2 * ring + k, d = sheet + i2 * ring + k;
    if (k === 0) idx.push(b, d, b + ring, b + ring, d, d + ring);
    else idx.push(b, b + ring, d, b + ring, d + ring, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // ---- topsheet, and a base that is not the topsheet upside down ----
  const c = document.createElement('canvas'); c.width = 256; c.height = 1024; const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 1024);
  grad.addColorStop(0, '#0ea5e9'); grad.addColorStop(0.5, '#1e293b'); grad.addColorStop(1, '#f472b6');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 1024);
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.font = '800 120px Inter, system-ui, sans-serif'; g.textAlign = 'center';
  g.save(); g.translate(128, 512); g.rotate(-Math.PI / 2); g.fillText('SHRED', 0, 40); g.restore();
  for (let i2 = 0; i2 < 12; i2++) { g.fillStyle = `rgba(255,255,255,${0.05 + (i2 % 3) * 0.04})`; g.fillRect(0, 60 + i2 * 80, 256, 6); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;

  geo.clearGroups();
  geo.addGroup(0, sheet * 0 + NZ * NX * 6, 1);                     // base
  geo.addGroup(NZ * NX * 6, geo.index.count - NZ * NX * 6, 0);     // deck and rim
  const deckMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.28, metalness: 0.15, envMapIntensity: 1.2 });
  // sintered base: near-black, semi-gloss, and nothing like the graphic on the other side
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.42, metalness: 0.05, envMapIntensity: 0.9 });
  const deck = new THREE.Mesh(geo, [deckMat, baseMat]);
  deck.castShadow = true; group.add(deck);

  // ---- steel edge, swept along the outline instead of a box round it ----
  {
    const ep = [], ei = [];
    for (let i2 = 0; i2 <= NZ; i2++) {
      const t = (i2 / NZ) * 2 - 1, z = t * L / 2, hw = halfW(t), y0 = baseY(t);
      for (const sgn of [-1, 1]) {
        ep.push(sgn * hw, y0, z);
        ep.push(sgn * (hw + 0.0016), y0 + 0.0055, z);
      }
    }
    for (let i2 = 0; i2 < NZ; i2++) for (const side of [0, 1]) {
      const o = i2 * 4 + side * 2;
      if (side === 0) ei.push(o, o + 1, o + 4, o + 1, o + 5, o + 4);
      else ei.push(o, o + 4, o + 1, o + 1, o + 4, o + 5);
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
    eg.setIndex(ei); eg.computeVertexNormals();
    group.add(new THREE.Mesh(eg, new THREE.MeshStandardMaterial({ color: 0xb8c0cc, metalness: 0.95, roughness: 0.18, envMapIntensity: 1.6 })));
  }

  // ---- bindings: baseplate, highback and two straps, set to a real stance ----
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x0b0f16, roughness: 0.75 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.5, metalness: 0.3, envMapIntensity: 1.0 });
  const hiMat = new THREE.MeshStandardMaterial({ color: 0x232c3a, roughness: 0.55, metalness: 0.2 });
  for (const [z, ang] of [[length * 0.2, THREE.MathUtils.degToRad(settings.regular ? 15 : -15)],
                          [-length * 0.2, THREE.MathUtils.degToRad(settings.regular ? -6 : 6)]]) {
    const b = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.175, 0.016, 0.265), plateMat);
    plate.position.y = 0.010; plate.castShadow = true; b.add(plate);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.006, 14), plateMat);
    disc.position.y = 0.020; b.add(disc);
    const hi = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.135, 0.018), hiMat);
    hi.position.set(0, 0.082, -0.118); hi.rotation.x = -0.28; hi.castShadow = true; b.add(hi);
    const ankle = new THREE.Mesh(new THREE.BoxGeometry(0.168, 0.042, 0.016), strapMat);
    ankle.position.set(0, 0.062, -0.030); ankle.rotation.x = -0.12; b.add(ankle);
    const toe = new THREE.Mesh(new THREE.BoxGeometry(0.150, 0.032, 0.014), strapMat);
    toe.position.set(0, 0.040, 0.088); toe.rotation.x = 0.35; b.add(toe);
    for (const sx of [-1, 1]) {
      const rat = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.026, 0.026), plateMat);
      rat.position.set(sx * 0.086, 0.062, -0.030); b.add(rat);
    }
    b.position.set(0, baseY((z / (L / 2))), z);
    b.rotation.y = ang;
    group.add(b);
  }
}

// ---------------- snow spray ----------------
function makeSpray(count = 600) {
  const pos = new Float32Array(count * 3), vel = new Float32Array(count * 3), life = new Float32Array(count);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.9, depthWrite: false }));
  points.frustumCulled = false;
  let head = 0;
  const e = new THREE.Vector3();
  return {
    points,
    emit(r, dt) {
      const amount = (r.carving * 0.7 + r.skidding * 1.3) * Math.min(1, r.speed / 8) * (r.grounded ? 1 : 0);
      const n = Math.floor(amount * dt * 900 + Math.random());
      const side = Math.sign(r.edgeDeg) || 1;
      for (let i = 0; i < n; i++) {
        const k = head = (head + 1) % count;
        e.copy(r.boardPos).addScaledVector(r.right, side * 0.16).addScaledVector(r.forward, (Math.random() - 0.5) * 1.2);
        pos[k * 3] = e.x; pos[k * 3 + 1] = e.y + 0.05; pos[k * 3 + 2] = e.z;
        const up = 1 + Math.random() * 2.5 * amount, out = (1 + Math.random() * 2) * amount * side;
        vel[k * 3] = r.right.x * out + r.vel.x * 0.35 + (Math.random() - 0.5);
        vel[k * 3 + 1] = up + Math.random();
        vel[k * 3 + 2] = r.right.z * out + r.vel.z * 0.35 + (Math.random() - 0.5);
        life[k] = 0.5 + Math.random() * 0.4;
      }
    },
    update(dt) {
      for (let i = 0; i < count; i++) {
        if (life[i] <= 0) { pos[i * 3 + 1] = -1000; continue; }
        life[i] -= dt; vel[i * 3 + 1] -= 9.81 * dt;
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      g.attributes.position.needsUpdate = true;
    },
  };
}

// ---------------- debug hook ----------------
window.__shred = {
  get state() {
    return rider ? {
      phase, speed: rider.speed, board: rider.boardPos.toArray(), rig: rider.pos.toArray(),
      yaw: Math.atan2(rider.vel.x, rider.vel.z), edgeDeg: rider.edgeDeg, pitchDeg: rider.pitchDeg,
      slipDeg: THREE.MathUtils.radToDeg(rider.slip), g: rider.lateralG, grounded: rider.grounded,
      carving: rider.carving, skidding: rider.skidding, standing: rider.standing,
      noseGap: rider.noseGap, tailGap: rider.tailGap,
      turnRadius: Number.isFinite(rider.turnRadius) ? rider.turnRadius : null,
      time: runTime,
      map: map?.id, inXR,
    } : null;
  },
  reset: () => resetRun(), load: (id) => loadMapById(id), settings,
  heightAt: (x, z) => terrain.heightAt(x, z), get map() { return map; },
};

// ---------------- boot ----------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
if (pinnedMap || rememberedMap) loadMapById(pinnedMap || rememberedMap);
setStatus('Connecting…');
