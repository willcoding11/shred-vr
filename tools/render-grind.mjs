// Renders the rail grind to a .wav so it can be listened to away from the headset.
//
// The bench at /mixer/ is for turning knobs; this is for sending someone the result. It drives the
// real GameAudio -- the same module the game imports -- through a small offline implementation of
// the handful of WebAudio nodes that graph actually uses, and calls update() sixty times a second
// exactly as the game loop does. So the speed ramps below are genuinely the synth responding to
// speed, not a fade drawn over a static sound.
//
// The DSP here is a reimplementation, so it is checked rather than trusted: --stats prints the
// same measurements taken from the browser's own OfflineAudioContext, and the two agree.
//
//   node tools/render-grind.mjs out.wav        the demo reel
//   node tools/render-grind.mjs out.wav --stats
import { writeFileSync } from 'node:fs';
import { RAIL_DEFAULTS } from '../public/game/audio.js';
import { SR, render } from './grind-render-lib.mjs';

// ---------------------------------------------------------------- the reel
const STEADY = () => ({ speed: 12 });
const RAMP = (t, secs) => ({ speed: 4 + (20 - 4) * (t / secs) });

// A ride onto the rail and off again: snow, the knock on, the grind, the knock off, snow.
const HIT = (t, secs) => {
  const on = t > secs * 0.28 && t < secs * 0.78 ? 1 : 0;
  return { speed: 13, onRail: on, carving: on ? 0 : 0.55, skidding: on ? 0 : 0.2 };
};
const HIT_FAST = (t, secs) => ({ ...HIT(t, secs), speed: 21 });

const SECTIONS = process.argv.includes('--reel') ? [
  ['1. what it was: stationary noise, filtered', 5, STEADY, { rateScale: 0, press: 0, grain: 6000, rough: 2.4, drive: 0.4, boardGain: 0 }, true],
  ['2. now: 4 m/s climbing to 20', 9, RAMP, {}, true],
  ['3. the same thing held at 12 m/s', 6, STEADY, {}, true],
  ['4. no normal force -- what ships', 6, STEADY, { press: 0 }, true],
  ['5. their ablation: no soft clip', 5, STEADY, { drive: 0.1 }, true],
  ['6. without the board under you', 5, STEADY, { boardGain: 0 }, true],
  ['7. a plastic box instead of steel', 5, STEADY, { grain: 2600, rough: 1.4, drive: 1.2, ringFreq: 190, ringSpread: 1.25, ringQ: 5, ringGain: 0.05, ringTilt: 0.9, hissFreq: 1700, hissQ: 0.9, hissGain: 0.22, tilt: 2200, lfoDepth: 25, flutter: 0.35 }, true],
  ['8. chattery', 5, STEADY, { grain: 150, rough: 0.2, drive: 7, ringQ: 30, ringGain: 0.22, ringTilt: 0.35, lfoRate: 13, lfoDepth: 140, flutter: 0.6, pressRate: 3.2 }, true],
] : [
  // What the headset will actually hand you: the whole mix, nothing soloed, nothing level-matched.
  ['1. onto the rail and off, 13 m/s, full mix', 7, HIT, {}, false],
  ['2. the same at 21 m/s, where the wind is loud', 7, HIT_FAST, {}, false],
  ['3. just the grind, soloed, 13 m/s', 5, STEADY, {}, true],
  ['4. a speed ramp, soloed: 4 m/s to 20', 9, RAMP, {}, true],
];

const GAP = Math.round(SR * 0.6);
const parts = [];
for (const [label, secs, frame, patch, solo] of SECTIONS) {
  process.stdout.write(`  ${label} ... `);
  const d = render(secs, frame, patch, solo);
  // A short fade each end: a section that starts mid-cycle clicks.
  const f = Math.round(SR * 0.03);
  for (let i = 0; i < f; i++) { d[i] *= i / f; d[d.length - 1 - i] *= i / f; }
  // The comparison reel matches the sections on loudness, because a section that is simply louder
  // always wins an A/B. The in-game version must not: the balance is the thing being shown.
  let s2 = 0; for (const v of d) s2 += v * v;
  const rms = Math.sqrt(s2 / d.length);
  const lev = process.argv.includes('--reel') ? (rms > 0 ? 0.05 / rms : 1) : 1;
  let peak = 0; for (let i = 0; i < d.length; i++) { d[i] *= lev; if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]); }
  console.log(`${secs}s, ${lev === 1 ? "level as-is" : `matched x${lev.toFixed(1)}`}, peak ${peak.toFixed(2)}`);
  parts.push(d, new Float32Array(GAP));
}

const total = parts.reduce((s, p) => s + p.length, 0);
const all = new Float32Array(total);
let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }

// One gain for the whole reel, so the sections stay honest against each other.
let peak = 0; for (const v of all) if (Math.abs(v) > peak) peak = Math.abs(v);
const g = peak > 0 ? 0.89 / peak : 1;
for (let i = 0; i < total; i++) all[i] *= g;

const buf = Buffer.alloc(44 + total * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(total * 2, 40);
for (let i = 0; i < total; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(all[i] * 32767))), 44 + i * 2);

const out = process.argv[2] || 'grind.wav';
writeFileSync(out, buf);
console.log(`\n${out}  ${(total / SR).toFixed(1)}s  ${(buf.length / 1024 / 1024).toFixed(2)} MB  (reel gain ${g.toFixed(2)})`);

// ---------------------------------------------------------------- the check on this renderer
for (const [nm, pt] of (process.argv.includes('--stats')
  ? [['full', {}], ['boardGain 0', { boardGain: 0 }], ['board at 60 Hz', { boardFreq: 60 }]] : [])) {
  const d = render(8, STEADY, pt);
  const N = 1024, H = 512, w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const fft = (re, im) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
        const a = ang * k, wr = Math.cos(a), wi = Math.sin(a), h = len / 2;
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + h] * wr - im[i + k + h] * wi, vi = re[i + k + h] * wi + im[i + k + h] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + h] = ur - vr; im[i + k + h] = ui - vi;
      }
    }
  };
  const env = [], cen = [];
  let pk = 0, s2 = 0;
  for (const v of d) { if (Math.abs(v) > pk) pk = Math.abs(v); s2 += v * v; }
  for (let p = 0; p + N <= d.length; p += H) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = d[p + i] * w[i];
    fft(re, im);
    let e = 0, num = 0;
    for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); e += m; num += m * k * SR / N; }
    env.push(e); cen.push(e > 1e-9 ? num / e : 0);
  }
  const sorted = [...env].sort((a, b) => a - b), thr = sorted[Math.floor(sorted.length * 0.35)];
  const keep = env.map((v, i) => [v, cen[i]]).filter(([v]) => v > thr);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const eK = keep.map((k) => k[0]), cK = keep.map((k) => k[1]);
  console.log('\nthis renderer, 8s at 12 m/s --', nm);
  console.log('  loudness wobble', (sd(eK) / mean(eK) * 100).toFixed(1) + '%',
              ' centroid', Math.round(mean(cK)) + ' Hz',
              ' centroid wobble', (sd(cK) / mean(cK) * 100).toFixed(1) + '%',
              ' crest', (pk / Math.sqrt(s2 / d.length)).toFixed(2));
}
