// Checks the rail grind is a scrape and not a hiss.
//
// The grind is tuned by ear on the bench at /mixer/, so nothing here judges how it sounds. What it
// does check is the thing that separates the two: a scrape is a train of micro-impacts whose rate
// rises with how fast you cross the surface, so the spectrum has to move with speed, not just the
// volume. Steady filtered noise cannot do that, which is why the first version read as wind.
// Everything else here is the same question asked of each slider -- does it reach the graph?
import { GameAudio, RAIL_DEFAULTS } from '../public/game/audio.js';

// Just enough WebAudio to let ensure() build the graph and record what update() aims each param at.
const param = (v = 0) => ({ value: v, target: v, setTargetAtTime(t) { this.target = t; } });
const node = () => ({ connect() {}, disconnect() {} });
const ctx = {
  currentTime: 0, sampleRate: 48000, state: 'running', destination: node(),
  createGain: () => ({ gain: param(), ...node() }),
  createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), ...node() }),
  createOscillator: () => ({ type: '', frequency: param(), start() {}, stop() {}, ...node() }),
  createWaveShaper: () => ({ curve: null, ...node() }),
  createBufferSource: () => ({ buffer: null, loop: false, playbackRate: param(1), start() {}, stop() {}, ...node() }),
  createBuffer: (_c, len) => { const d = new Float32Array(len); return { length: len, getChannelData: () => d }; },
};
global.window = { AudioContext: function () { return ctx; } };

let fail = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) fail++;
};

const a = new GameAudio();
// There is no fetch out here, so hand it a stand-in loop before it builds. Without this it takes
// the missing-asset path, falls back to the synth, and every question below is about the wrong
// sound while still reporting ok -- which is worse than failing.
a.railSampleBuffer = ctx.createBuffer(1, 4800, 48000);
a.ensure();
a.railPreview = true;
const ride = (o) => a.update(1 / 60, { grounded: true, onRail: 1, carving: 0.5, skidding: 0.15, ...o });
const rate = () => a.railSurface.playbackRate.target;
const surface = () => a.railSurface.buffer.getChannelData();
const rms = (d) => { let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length); };

// ---------------------------------------------------------------- speed has to move the timbre
console.log('\n-- speed reads the surface faster --');
ride({ speed: 9 });  const r9 = rate();
ride({ speed: 18 }); const r18 = rate();
ride({ speed: 4.5 }); const r45 = rate();
ok('at the reference speed the profile plays at its baked rate', Math.abs(r9 - 1) < 1e-6, `${r9}`);
ok('twice the speed reads it twice as fast', Math.abs(r18 / r9 - 2) < 1e-6, `${r18} vs ${r9}`);
ok('half the speed reads it half as fast', Math.abs(r45 / r9 - 0.5) < 1e-6, `${r45}`);
ok('the read rate is clamped, so a crash cannot chipmunk it',
   (ride({ speed: 400 }), rate()) <= 6, `${rate()} at 400 m/s`);
a.setRail({ rateScale: 0 });
ride({ speed: 18 });
ok('rateScale 0 pins the rate, putting the old stationary hiss back', rate() === 0.05, `${rate()}`);
a.setRail({ rateScale: RAIL_DEFAULTS.rateScale });

// ---------------------------------------------------------------- the surface itself
console.log('\n-- the baked surface --');
const base = surface();
ok('a surface got baked at all', base.length === 96000 && rms(base) > 0, `${base.length} samples, rms ${rms(base).toFixed(3)}`);
ok('it is normalised, so drive means the same thing at every roughness',
   Math.max(...base.map(Math.abs)) > 0.999, `peak ${Math.max(...base.map(Math.abs)).toFixed(4)}`);
// After differentiating round the loop point, the join should be an ordinary sample, not a step.
ok('the loop joins up silently -- no tick once a cycle', Math.abs(base[0]) < rms(base) * 12,
   `first sample ${base[0].toFixed(4)} vs rms ${rms(base).toFixed(4)}`);

// Sparse catches leave a spikier profile than dense ones. Peak is pinned at 1 by the normalise,
// so crest factor is just 1/rms -- it should fall as the catches crowd together.
const crestAt = (grain) => { a.setRail({ grain }); a.bakeSurface(); return 1 / rms(surface()); };
const sparse = crestAt(120), dense = crestAt(4000);
ok('sparse asperities give a spikier surface than dense ones', sparse > dense * 1.3,
   `crest ${sparse.toFixed(1)} at 120/s vs ${dense.toFixed(1)} at 4000/s`);
a.setRail({ grain: RAIL_DEFAULTS.grain }); a.bakeSurface();

// Crest factor hangs on whichever catch happened to come out biggest, which varies enough between
// bakes to make a flaky test. How much of the surface is flat between the catches does not.
const flatAt = (rough) => {
  // Pin the catch rate: this is a question about roughness, and dense catches fill the gaps too.
  a.setRail({ rough, grain: 900 }); a.bakeSurface();
  const d = surface(); let n = 0;
  for (const v of d) if (Math.abs(v) < 0.002) n++;
  return n / d.length;
};
const bare = flatAt(0.02), filled = flatAt(2.5);
ok('with roughness off the surface is flat between the catches', bare > 0.8, `${(bare * 100).toFixed(0)}% flat`);
ok('roughness fills that in', filled < 0.2, `${(filled * 100).toFixed(0)}% flat at rough 2.5`);
const ladder = [0.02, 0.2, 0.55, 1.5, 2.5].map(flatAt);
ok('and it does so all the way up, not just at the ends',
   ladder.every((v, i) => i === 0 || v < ladder[i - 1]), ladder.map((v) => v.toFixed(2)).join(' > '));
a.setRail({ rough: RAIL_DEFAULTS.rough, grain: RAIL_DEFAULTS.grain }); a.bakeSurface();

// ---------------------------------------------------------------- grit
console.log('\n-- the soft clip --');
const curveAt = (drive) => { a.setRail({ drive }); return [...a.railShape.curve]; };
const soft = curveAt(0.3), hard = curveAt(8);
const midIdx = Math.round(1024 * 0.625); // a quarter of the way up the positive half
ok('drive reaches the shaper and bends it', hard[midIdx] > soft[midIdx] * 1.5,
   `${hard[midIdx].toFixed(3)} vs ${soft[midIdx].toFixed(3)} at x=0.25`);
ok('the shaper stays bounded at both ends', Math.abs(hard[0] + 1) < 1e-6 && Math.abs(hard[1023] - 1) < 1e-6);
ok('low drive is near enough a straight wire', Math.abs(soft[midIdx] - 0.25) < 0.02, `${soft[midIdx].toFixed(3)}`);
a.setRail({ drive: RAIL_DEFAULTS.drive });

// ---------------------------------------------------------------- the bar
console.log('\n-- the bar --');
ride({ speed: 9 });
const partials = () => a.railModes.map((m) => m.f.frequency.target);
const ratios = () => { const p = partials(); return p.map((f) => +(f / p[0]).toFixed(2)); };
// A free-free steel bar rings at 1 : 2.757 : 5.404 : 8.933 -- solved from cos(x)cosh(x) = 1.
const BAR = [1, 2.757, 5.404, 8.933];
const err = ratios().map((r, i) => Math.abs(r - BAR[i]) / BAR[i]);
ok('the default spread lands on a steel bar, not a harmonic series',
   Math.max(...err) < 0.07, `${ratios().join(' : ')} vs ${BAR.join(' : ')}`);
a.setRail({ ringSpread: 1 }); ride({ speed: 9 });
ok('spread 1 collapses it to a harmonic pipe', ratios().join() === '1,2,3,4', ratios().join(' : '));
a.setRail({ ringSpread: RAIL_DEFAULTS.ringSpread }); ride({ speed: 9 });
a.setRail({ ringFreq: 900 }); ride({ speed: 9 });
ok('ringFreq moves the whole set', Math.abs(partials()[0] - 900) < 1e-6, `${partials()[0]}`);
a.setRail({ ringFreq: RAIL_DEFAULTS.ringFreq }); ride({ speed: 9 });
const gains = () => a.railModes.map((m) => m.g.gain.target);
// The bar ships silent now that the grind is a recording, so turn it up to ask about its shape.
a.setRail({ ringGain: 0.3 }); ride({ speed: 9 });
ok('the upper partials sit below the first', gains().every((g, i, all) => i === 0 || g < all[i - 1]),
   gains().map((g) => g.toFixed(3)).join(' > '));
a.setRail({ ringTilt: 0 }); ride({ speed: 9 });
ok('tilt 0 levels them out', new Set(gains().map((g) => g.toFixed(6))).size === 1);
a.setRail({ ringTilt: RAIL_DEFAULTS.ringTilt, ringGain: RAIL_DEFAULTS.ringGain });
a.setRail({ ringQ: 30 }); ride({ speed: 9 });
ok('ringQ reaches every partial', a.railModes.every((m) => m.f.Q.target === 30));
a.setRail({ ringQ: RAIL_DEFAULTS.ringQ });
a.setRail({ ringGain: 0 }); ride({ speed: 9 });
ok('ringGain 0 silences the bar', gains().every((g) => g === 0));
a.setRail({ ringGain: RAIL_DEFAULTS.ringGain });

// ---------------------------------------------------------------- the recording
console.log('\n-- the recording --');
ride({ speed: 9 });
ok('the grind ships as the recorded loop, not the synth',
   RAIL_DEFAULTS.sampleGain > 0 && RAIL_DEFAULTS.hissGain === 0 && RAIL_DEFAULTS.ringGain === 0,
   `sampleGain ${RAIL_DEFAULTS.sampleGain}`);
ok('its level reaches the graph', a.railSampleGain.gain.target === RAIL_DEFAULTS.sampleGain);
ok('the loop plays through the shared envelope, so the duck and the speed curve still own it',
   a.railOut.gain.target > 0);
// Same velocity coupling the synth taught us, held back so it does not sound like tape speed.
const srate = () => a.railSample.playbackRate.target;
ride({ speed: 9 });  const s9 = srate();
ride({ speed: 36 }); const s36 = srate();
ride({ speed: 2.25 }); const s225 = srate();
ok('at the reference speed the loop plays at its own rate', Math.abs(s9 - 1) < 1e-6, `${s9}`);
ok('four times the speed does not mean four times the pitch', s36 > 1.1 && s36 < 2.01, `${s36.toFixed(2)}x`);
ok('and a quarter of it does not drop an octave and a half', s225 > 0.49 && s225 < 0.95, `${s225.toFixed(2)}x`);
a.setRail({ sampleTrack: 0 }); ride({ speed: 36 });
ok('sampleTrack 0 pins the pitch entirely', Math.abs(srate() - 1) < 1e-6);
a.setRail({ sampleTrack: RAIL_DEFAULTS.sampleTrack });
// A missing asset should cost the texture, not the whole sound.
// Built with no buffer seeded and no fetch available, which is exactly the missing-asset path.
const b = new GameAudio();
b.ensure();
ok('if the recording will not load it falls back to the synth',
   b.rail.hissGain > 0 && b.rail.ringGain > 0 && b.rail.sampleGain === 0,
   `hiss ${b.rail.hissGain}, ring ${b.rail.ringGain}`);

// ---------------------------------------------------------------- the rest of the sliders
console.log('\n-- the rest --');
a.setRail({ hissFreq: 5000, hissQ: 9, hissGain: 0.4 }); ride({ speed: 9 });
ok('the hiss sliders reach the filter', a.railHiss.f.frequency.target === 5000
   && a.railHiss.f.Q.target === 9 && a.railHiss.g.gain.target === 0.4);
a.setRail({ hissFreq: RAIL_DEFAULTS.hissFreq, hissQ: RAIL_DEFAULTS.hissQ, hissGain: RAIL_DEFAULTS.hissGain });
a.setRail({ lfoRate: 20, lfoDepth: 300 }); ride({ speed: 9 });
ok('the wobble sliders reach the LFO', a.railLfo.frequency.target === 20 && a.railLfoGain.gain.target === 300);
a.setRail({ lfoRate: RAIL_DEFAULTS.lfoRate, lfoDepth: RAIL_DEFAULTS.lfoDepth });
a.setRail({ flutter: 0, press: 0 }); ride({ speed: 9 });
ok('with nothing wobbling, the bus sits steady and full',
   a.railFlutter.gain.target === 0 && a.railPressLvl.gain.target === 0 && a.railOut.gain.target === 1);
a.setRail({ flutter: 0.5, press: 0.6 }); ride({ speed: 9 });
const budget = a.railOut.gain.target + a.railFlutter.gain.target + a.railPressLvl.gain.target;
ok('every wobble comes out of the bus headroom, so it cannot clip', Math.abs(budget - 1) < 1e-6,
   `${a.railOut.gain.target.toFixed(2)} + ${a.railFlutter.gain.target.toFixed(2)}`
   + ` + ${a.railPressLvl.gain.target.toFixed(2)} = ${budget.toFixed(2)}`);
a.setRail({ flutter: RAIL_DEFAULTS.flutter, press: RAIL_DEFAULTS.press });

// ---------------------------------------------------------------- how hard you lean on it
console.log('\n-- normal force --');
// It ships off: their swell models a hand stroking back and forth, and a board sliding a rail at
// speed is a steady contact. It stays on a slider because it is right for a slow scrape.
ride({ speed: 9 });
ok('the game ships with no normal-force swell', RAIL_DEFAULTS.press === 0
   && a.railPressLvl.gain.target === 0 && a.railPressBite.gain.target === 0);
a.setRail({ press: 0.9 }); ride({ speed: 9 });
ok('turning it up drives the level and the bite together, which is the whole point of it',
   a.railPressLvl.gain.target > 0 && a.railPressBite.gain.target > 0,
   `level ${a.railPressLvl.gain.target.toFixed(2)}, bite ${a.railPressBite.gain.target.toFixed(2)}`);
ok('the bite goes into the gain ahead of the soft clip, not after it',
   a.railPressBite.gain.target > 0 && a.railPre.gain.value === 1, 'railPre is the clip input');
a.setRail({ press: RAIL_DEFAULTS.press });
a.setRail({ pressRate: 2.5 }); ride({ speed: 9 });
ok('pressRate sets how often it loads and unloads', a.railPress.playbackRate.target === 2.5);
a.setRail({ pressRate: RAIL_DEFAULTS.pressRate });
a.setRail({ tilt: 900 }); ride({ speed: 9 });
ok('tilt reaches the filter that tips the derivative back down', a.railTilt.frequency.target === 900);
a.setRail({ tilt: RAIL_DEFAULTS.tilt });

// ---------------------------------------------------------------- level, duck, and the game
console.log('\n-- level, duck, and the game --');
ride({ speed: 9 });  const full = a.railOut.gain.target;
ride({ speed: 3 });  const third = a.railOut.gain.target;
ok('speed scales the level as well as the timbre', Math.abs(third / full - 1 / 3) < 0.01,
   `ratio ${(third / full).toFixed(3)}`);
a.setRail({ speedRef: 3 }); ride({ speed: 3 });
ok('lowering "Full at" reaches full sooner', Math.abs(a.railOut.gain.target - full) < 1e-6);
a.setRail({ speedRef: RAIL_DEFAULTS.speedRef });

ride({ speed: 12 });
ok('duck on silences the snow under the rail -- carve, skid and the board rumble alike',
   a.carve.g.gain.target === 0 && a.skid.g.gain.target === 0 && a.rumble.g.gain.target === 0);
a.setRail({ duck: false }); ride({ speed: 12 });
ok('duck off leaves the snow playing', a.carve.g.gain.target > 0 && a.skid.g.gain.target > 0,
   `carve ${a.carve.g.gain.target.toFixed(3)}`);
a.setRail({ ...RAIL_DEFAULTS });

a.railPreview = false;
a.update(1 / 60, { speed: 14, grounded: true, onRail: 0, carving: 0.5, skidding: 0.15 });
ok('no grind when not on a rail', a.railOut.gain.target === 0 && a.railFlutter.gain.target === 0);
ok('snow plays normally off the rail', a.carve.g.gain.target > 0, `carve ${a.carve.g.gain.target.toFixed(3)}`);

console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
