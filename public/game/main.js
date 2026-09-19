// Shred VR — game entry.
//
// This is a VR game and only a VR game. On a desktop browser you get a preview of the map you
// are editing and a button to put the headset on; you cannot ride, because the whole control
// scheme is "your two controllers are your two feet" and there is nothing to map that onto.
import * as THREE from 'three';
import { Terrain } from '../shared/terrain.js';
import { PropRenderer, makeStartGate, makeFinishBanner } from '../shared/props.js';
import { Scenery } from '../shared/scenery.js';
import { LiveClient } from '../shared/live.js';
import { deserializeMap, applyRegion, PROP_TYPES, bounds, lowestHeight } from '../shared/mapformat.js';
import { Rider, SNOW } from './physics.js';
import { BoardControls } from './controls.js';
import { Hud, VrMenu, Vignette, fmtTime } from './hud.js';
import { GameAudio } from './audio.js';

const DEFAULTS = {
  regular: true, vignette: 0.6, realism: 'real', shadows: true, snowfall: true, legRate: 13, relief: 1,
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
const scenery = new Scenery(scene, { shadows: settings.shadows });
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
let spatial = new Map(), gates = [];
let phase = 'idle';                 // idle (not in VR) | riding | finished
let runTime = 0, timerOn = false, checkpoint = null, best = null, missedFinish = false;
let flash = 0;
let inXR = false, mapsList = [], telemetryT = 0, propSyncT = 0;
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
  if (!terrain) { terrain = new Terrain(map, { shadows: settings.shadows, relief: settings.relief }); scene.add(terrain.mesh); }
  else terrain.setMap(map);
  if (!props) { props = new PropRenderer(map, { shadows: settings.shadows }); scene.add(props.group); }
  else props.setMap(map);
  rebuildMarkers(); rebuildSpatial();
  scenery.setEnv({ ...map.env, snowfall: settings.snowfall ? map.env.snowfall : 0 });
  scenery.setGround(lowestHeight(map));
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

function rebuildMarkers() {
  if (!startGate) { startGate = makeStartGate(); scene.add(startGate); }
  placeOnGround(startGate, map.start.x, map.start.z, map.start.yaw || 0);
  if (!finishBanner || finishWidth !== map.finish.w) {
    if (finishBanner) { scene.remove(finishBanner); finishBanner.geometry.dispose(); finishBanner.material.dispose(); }
    finishBanner = makeFinishBanner(map.finish.w); finishWidth = map.finish.w; scene.add(finishBanner);
  }
  placeOnGround(finishBanner, map.finish.x, map.finish.z, map.finish.yaw || 0);
  const prev = gates;
  gates = map.props.filter((p) => p.t === 'gate').map((p) => {
    const old = prev.find((g) => Math.abs(g.x - p.x) < 0.02 && Math.abs(g.z - p.z) < 0.02);
    return { x: p.x, z: p.z, r: p.r || 0, w: PROP_TYPES.gate.width, passed: !!old?.passed, missed: !!old?.missed };
  });
  $('gatesTotal').textContent = gates.length;
}
function placeOnGround(obj, x, z, yaw) { obj.position.set(x, terrain.heightAt(x, z), z); obj.rotation.y = yaw; obj.castShadow = true; }

function rebuildSpatial() {
  spatial = new Map();
  for (const p of map.props) {
    const def = PROP_TYPES[p.t]; if (!def) continue;
    if (p.t === 'gate') {
      const c = Math.cos(p.r || 0), s = Math.sin(p.r || 0), hw = def.width / 2;
      for (const side of [-1, 1]) addSpatial({ x: p.x + side * hw * c, z: p.z - side * hw * s, r: 0.12, hard: false, t: 'pole' });
      continue;
    }
    if (p.t === 'fence') {
      const c = Math.cos(p.r || 0), s = Math.sin(p.r || 0), hl = def.len / 2;
      for (let k = -1; k <= 1; k += 0.25) addSpatial({ x: p.x + k * hl * c, z: p.z - k * hl * s, r: 0.7, hard: true, t: 'fence' });
      continue;
    }
    if (def.r > 0) addSpatial({ x: p.x, z: p.z, r: def.r * (p.s || 1), hard: def.hard, t: p.t });
  }
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

// ---------------- run control ----------------
function resetRun(toCheckpoint = false) {
  if (!map || !rider) return;
  const cp = toCheckpoint && checkpoint ? checkpoint : { x: map.start.x, z: map.start.z, yaw: map.start.yaw || 0 };
  rider.reset(cp.x, cp.z, cp.yaw, controls.pose);
  legY = null;
  prevX = cp.x; prevZ = cp.z; missedFinish = false;
  if (!toCheckpoint) { runTime = 0; timerOn = false; for (const g of gates) { g.passed = g.missed = false; } checkpoint = null; }
  phase = inXR ? 'riding' : 'idle';
  if (inXR) hud.message(toCheckpoint ? 'Back on your feet' : map.name, 'Point the nose downhill, or shove a dug-in edge to scoot off the mark', 4);
}

function finished() {
  phase = 'finished'; timerOn = false;
  audio.finish();
  const missed = gates.filter((g) => g.missed).length;
  const penalty = missed * 2 + (missedFinish ? 5 : 0);
  const total = runTime + penalty;
  const isBest = best == null || total < best;
  if (isBest) { best = total; localStorage.setItem('shred.best.' + map.id, String(best)); }
  const sub = [missed ? `${missed} gate${missed > 1 ? 's' : ''} missed (+${missed * 2}s)` : '',
    missedFinish ? 'outside the banner (+5s)' : ''].filter(Boolean).join(' · ') || 'Clean run';
  hud.message(`Finish ${fmtTime(total)}${isBest ? ' · New best!' : ''}`, sub, 6);
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
  propSyncT = 0.25; flashLive();
});
live.on('props', (msg) => {
  if (!map || msg.id !== map.id) return;
  map.props = msg.props; if (msg.start) map.start = msg.start; if (msg.finish) map.finish = msg.finish;
  props.sync(); rebuildMarkers(); rebuildSpatial(); flashLive();
});
live.on('env', (msg) => {
  if (!map || msg.id !== map.id) return;
  map.env = { ...map.env, ...msg.env };
  scenery.setEnv({ ...map.env, snowfall: settings.snowfall ? map.env.snowfall : 0 });
  scenery.setGround(lowestHeight(map));
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
let acc = 0, calibrated = false, sawHands = 0, slowMo = 1, legY = null, legVy = 0, bootSag = 0;
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

  camera.getWorldPosition(tmpV);
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
      // tap once for the last gate, twice quickly to start the run over
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
    if (phase === 'riding') { checkGates(); checkBounds(); }
    else if (phase === 'finished') checkBounds();
    if (!timerOn && rider.speed > 1 && rider.boardPos.z > map.start.z + 4) timerOn = true;
    if (timerOn && phase === 'riding') runTime += dtReal;
    spray.emit(rider, dt);
  }

  // the rig IS the rider; the board is drawn where the hands are
  // The rig NEVER rotates. Your heading is your body's heading, in the room, and a turn is
  // something you make by physically swinging the board round. Nothing spins the world for you.
  rig.position.copy(rider.pos);
  rig.rotation.set(0, 0, 0);

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
  legY += legVy * dtReal;
  const rate = rider.grounded && !rider.standing ? settings.legRate : 30;
  legY += (rider.pos.y - legY) * Math.min(1, dtReal * rate);
  // The suspension needs more travel the faster you go, for the same reason your knees do.
  const travel = 0.09 + Math.min(0.10, rider.speed * 0.005);
  const sag = THREE.MathUtils.clamp(rider.pos.y - legY, -travel, travel);
  legY = rider.pos.y - sag;
  rig.position.y = rider.pos.y - sag;
  bootSag = sag;

  // DRAW from the unsmoothed pose. The physics reads the smoothed one, because a 60 ms filter
  // is what keeps tracking noise out of the forces, but drawing through that same filter puts
  // 60 ms between your hands and the board you can see. That lag is most of what reads as
  // "floaty" in a headset, and it costs nothing to remove.
  const draw = controls.rawPose.valid ? controls.rawPose : pose;
  if (draw.valid) {
    boardGroup.visible = true;
    boardGroup.position.copy(draw.center);
    boardGroup.position.y += sag;                 // ...so the board is still on the snow
    const side = tmpV.crossVectors(draw.up, draw.nose).normalize();
    boardGroup.quaternion.setFromRotationMatrix(_basis.makeBasis(side, draw.up, draw.nose));
  } else boardGroup.visible = false;

  // Nothing rotates the world any more, so the only thing left to soften is the load in a
  // hard carve. That is real acceleration you can feel, not induced vection.
  vignette.update(dt, Math.min(1, settings.vignette * THREE.MathUtils.clamp(Math.abs(rider.lateralG) / 2.6, 0, 1) + flash * 0.9));

  audio.update(dtReal, { speed: rider.speed * slowMo, carving: rider.carving, skidding: rider.skidding, grounded: rider.grounded, tuck: tuckAmount() });
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
  preview.angle += dt * 0.06;
  const s = map.start;
  const y = terrain.heightAt(s.x, s.z);
  const yaw = preview.yaw + preview.angle, pitch = preview.pitch;
  rig.position.set(
    s.x + Math.sin(yaw) * Math.cos(pitch) * preview.dist,
    y + Math.sin(pitch) * preview.dist,
    s.z + Math.cos(yaw) * Math.cos(pitch) * preview.dist - 40,
  );
  rig.rotation.set(0, 0, 0);
  camera.position.set(0, 0, 0);
  camera.lookAt(s.x, y + 4, s.z + 45);
  boardGroup.visible = false;
  for (const b of bootMarks) b.visible = false;
  updateDomHud(hudState());
}
function framePreview() { preview.angle = 0; }
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
    gates: gates.filter((g) => g.passed).length, gatesTotal: gates.length,
    missed: gates.filter((g) => g.missed).length,
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
  for (const o of nearby(p.x, p.z)) {
    const d = Math.hypot(o.x - p.x, o.z - p.z);
    if (d >= o.r + 0.28) continue;
    if (o.hard) {
      // Solid, so it stops you dead and shoves you clear. It does not end the run -- you just
      // have to get going again, which costs you far more than a reset screen would.
      // Guarded, because collisions run per physics substep: without this a single tree took
      // 88% of your speed once for every substep it stayed inside you.
      const nx = (p.x - o.x) / (d || 1), nz = (p.z - o.z) / (d || 1);
      rider.pos.x += nx * (o.r + 0.35 - d); rider.pos.z += nz * (o.r + 0.35 - d);
      // At most one hard stop per frame, whatever you clipped. Remembering a single last-hit
      // object is not enough: a fence is built from nine overlapping spheres 0.75 m apart, so you
      // are inside two or three at once, the guard never matches, and the 88% brake compounds
      // once per sphere per substep. Measured, riding into one fence at 15 m/s left the rider at
      // 4.8e-110 m/s -- total annihilation, which then dropped them in a heap on the hill.
      if (!hitThisFrame) {
        if (rider.speed > 3.5) audio.crash();
        rider.vel.multiplyScalar(0.12);
        hitThisFrame = true;
      }
    } else {
      const nx = (p.x - o.x) / (d || 1), nz = (p.z - o.z) / (d || 1);
      rider.pos.x += nx * (o.r + 0.3 - d); rider.pos.z += nz * (o.r + 0.3 - d);
      rider.vel.multiplyScalar(o.t === 'pole' ? 0.85 : 0.6);
      audio.stumble();
    }
  }
}

function checkGates() {
  const p = rider.boardPos;
  for (const g of gates) {
    if (g.passed || g.missed) continue;
    const c = Math.cos(g.r), s = Math.sin(g.r);
    const lx = (p.x - g.x) * c - (p.z - g.z) * s, lz = (p.x - g.x) * s + (p.z - g.z) * c;
    const plx = (prevX - g.x) * c - (prevZ - g.z) * s, plz = (prevX - g.x) * s + (prevZ - g.z) * c;
    if (plz < 0 && lz >= 0 && Math.abs((lx + plx) / 2) <= g.w / 2) {
      g.passed = true; checkpoint = { x: g.x, z: g.z + 1, yaw: g.r }; audio.gate(); hud.message('Gate', '', 0.6);
    }
    if (lz > 4 && !g.passed) { g.missed = true; audio.miss(); hud.message('Missed gate  +2s', '', 1.2); }
  }
  const f = map.finish;
  if (prevZ < f.z && p.z >= f.z) { missedFinish = Math.abs(p.x - f.x) > f.w / 2 + 1; finished(); }
  prevX = p.x; prevZ = p.z;
}

function checkBounds() {
  const b = bounds(map), p = rider.boardPos, m = 2.5;
  if (p.x < b.minX + m) { rider.pos.x += (b.minX + m) - p.x; rider.vel.x = Math.abs(rider.vel.x) * 0.3; }
  if (p.x > b.maxX - m) { rider.pos.x -= p.x - (b.maxX - m); rider.vel.x = -Math.abs(rider.vel.x) * 0.3; }
  if (p.z < b.minZ + 1) { rider.pos.z += (b.minZ + 1) - p.z; rider.vel.z = Math.abs(rider.vel.z) * 0.3; }
  if (p.z > b.maxZ - m) {
    if (phase === 'finished') { rider.pos.z -= p.z - (b.maxZ - m); rider.vel.set(0, 0, 0); return; }
    hud.message('End of the run', '', 1.5); resetRun();
  }
}

function updateDomHud(s) {
  $('speed').textContent = Math.round(s.speed * 3.6);
  $('time').textContent = fmtTime(s.time);
  $('gates').textContent = s.gates; $('missed').textContent = s.missed ? `· ${s.missed} missed` : '';
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
function buildBoard(group, length = 1.5) {
  const shape = new THREE.Shape();
  const L = length, W = 0.27, r = 0.13;
  shape.moveTo(-W / 2 + r, -L / 2); shape.lineTo(W / 2 - r, -L / 2); shape.quadraticCurveTo(W / 2, -L / 2, W / 2, -L / 2 + r);
  shape.lineTo(W / 2 - 0.012, L / 2 - r); shape.quadraticCurveTo(W / 2, L / 2, W / 2 - r, L / 2);
  shape.lineTo(-W / 2 + r, L / 2); shape.quadraticCurveTo(-W / 2, L / 2, -W / 2 + 0.012, L / 2 - r);
  shape.lineTo(-W / 2, -L / 2 + r); shape.quadraticCurveTo(-W / 2, -L / 2, -W / 2 + r, -L / 2);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2 });
  geo.rotateX(-Math.PI / 2); geo.translate(0, -0.011, 0);
  const c = document.createElement('canvas'); c.width = 256; c.height = 1024; const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 1024);
  grad.addColorStop(0, '#0ea5e9'); grad.addColorStop(0.5, '#1e293b'); grad.addColorStop(1, '#f472b6');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 1024);
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.font = '800 120px Inter, system-ui, sans-serif'; g.textAlign = 'center';
  g.save(); g.translate(128, 512); g.rotate(-Math.PI / 2); g.fillText('SHRED', 0, 40); g.restore();
  for (let i = 0; i < 12; i++) { g.fillStyle = `rgba(255,255,255,${0.05 + (i % 3) * 0.04})`; g.fillRect(0, 60 + i * 80, 256, 6); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / W + 0.5, uv.getY(i) / L + 0.5);
  const deck = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.1 }));
  deck.castShadow = true; group.add(deck);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(W + 0.006, 0.006, L + 0.006),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.6, roughness: 0.4 }));
  edge.position.y = -0.008; group.add(edge);
  // bindings sit where your hands are: at +/- a third of the board
  for (const z of [length * 0.2, -length * 0.2]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.03, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 }));
    b.position.set(0, 0.015, z); b.castShadow = true; group.add(b);
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
      time: runTime, gates: gates.filter((g) => g.passed).length, missed: gates.filter((g) => g.missed).length,
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
