// The offline WebAudio the grind gets rendered through, shared by the tools that need it.
//
// Just the handful of node types audio.js actually uses, enough to run the real graph outside a
// browser and get samples back. It is a reimplementation, so it is checked rather than trusted:
// render-grind.mjs --stats prints the same measurements taken from the browser's own
// OfflineAudioContext, and the two agree.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GameAudio, RAIL_DEFAULTS } from '../public/game/audio.js';

// The grind is a recording now, and there is no fetch out here. Read it off disk and hand it to
// GameAudio before it builds, so what these tools render is what the headset plays -- otherwise
// they would quietly fall back to the synth and every measurement would describe the wrong sound.
const ASSET = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'audio', 'rail-grind.wav');
function loadSample(make) {
  let b;
  try { b = readFileSync(ASSET); } catch { return null; }
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12) };
    if (id === 'data') data = { at: p + 8, size: Math.min(size, b.length - p - 8) };
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) return null;
  const frames = Math.floor(data.size / 2 / fmt.ch);
  const buf = make(1, frames, fmt.sr), d = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < fmt.ch; c++) v += b.readInt16LE(data.at + (i * fmt.ch + c) * 2) / 32768;
    d[i] = v / fmt.ch;
  }
  return buf;
}

export const SR = 44100;

// ---------------------------------------------------------------- a very small WebAudio
// Pull-based and memoised by sample index, so a node feeding five filters is still computed once.
class Node {
  constructor() { this.inputs = []; this._i = -1; this._v = 0; }
  connect(t) { (t instanceof Param ? t : t).inputs.push(this); return t; }
  disconnect() { }
  sum(i) { let s = 0; for (const n of this.inputs) s += n.out(i); return s; }
  out(i) { if (this._i !== i) { this._i = i; this._v = this.calc(i); } return this._v; }
  calc() { return 0; }
}

// An AudioParam is its own value plus whatever is patched into it -- which is how the flutter and
// the press reach the bus gain, and how the LFO reaches a filter frequency.
class Param {
  constructor(v = 0) { this.value = v; this.inputs = []; this._t0 = 0; this._from = v; this._to = v; this._tc = 0; this.ev = []; }
  // update() calls this sixty times a second on a dozen params, so it overwrites rather than
  // queueing -- a growing event list scanned per sample would be quadratic and crawl.
  setTargetAtTime(target, when, tc) { this._from = this.get0(when); this._to = target; this._t0 = when; this._tc = tc; return this; }
  // The one-shots (the knock on and off the steel) ramp instead, on throwaway nodes with two or
  // three events each, so those do get a list.
  setValueAtTime(v, t) { this.ev.push({ k: 's', v, t }); return this; }
  linearRampToValueAtTime(v, t) { this.ev.push({ k: 'l', v, t }); return this; }
  exponentialRampToValueAtTime(v, t) { this.ev.push({ k: 'e', v, t }); return this; }
  cancelScheduledValues() { this._to = this._from = this.value; this._tc = 0; this.ev.length = 0; return this; }
  get0(t) {
    if (this.ev.length) {
      let cur = this.value;
      for (let i = 0; i < this.ev.length; i++) {
        const e = this.ev[i];
        if (e.t > t) {
          if (e.k === 's') return cur;
          const t0 = i ? this.ev[i - 1].t : 0, f = (t - t0) / Math.max(1e-9, e.t - t0);
          if (e.k === 'l') return cur + (e.v - cur) * f;
          const a = Math.max(1e-6, cur), b = Math.max(1e-6, e.v);
          return a * Math.pow(b / a, f);
        }
        cur = e.v;
      }
      return cur;
    }
    if (!this._tc) return this.value;
    return this._to + (this._from - this._to) * Math.exp(-Math.max(0, t - this._t0) / this._tc);
  }
  at(i) { let s = this.get0(i / SR); for (const n of this.inputs) s += n.out(i); return s; }
}
// Assigning .value has to win over a running ramp, the way cancel-then-set does in the browser.
Object.defineProperty(Param.prototype, 'value', {
  get() { return this._val; },
  set(v) { this._val = v; this._from = this._to = v; this._tc = 0; },
});

class Gain extends Node {
  constructor() { super(); this.gain = new Param(1); }
  calc(i) { return this.sum(i) * this.gain.at(i); }
}

class BufferSource extends Node {
  constructor() { super(); this.buffer = null; this.loop = false; this.playbackRate = new Param(1); this.pos = 0; this.on = false; }
  start() { this.on = true; } stop() { this.on = false; }
  calc(i) {
    if (!this.on || !this.buffer) return 0;
    const d = this.buffer.data, n = d.length;
    // The buffer may be baked at its own rate (the slow wanders are), so resample as the graph does.
    const step = this.playbackRate.at(i) * (this.buffer.sampleRate / SR);
    const p = this.pos;
    this.pos += step;
    if (this.loop) { while (this.pos >= n) this.pos -= n; while (this.pos < 0) this.pos += n; }
    else if (p >= n) return 0;
    const i0 = Math.floor(p), f = p - i0;
    return d[i0 % n] * (1 - f) + d[(i0 + 1) % n] * f;
  }
}

class Oscillator extends Node {
  constructor() { super(); this.type = 'sine'; this.frequency = new Param(440); this.phase = 0; this.on = false; }
  start() { this.on = true; } stop() { this.on = false; }
  calc(i) {
    if (!this.on) return 0;
    this.phase += 2 * Math.PI * this.frequency.at(i) / SR;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return Math.sin(this.phase);
  }
}

class WaveShaper extends Node {
  constructor() { super(); this.curve = null; }
  calc(i) {
    const x = this.sum(i);
    if (!this.curve) return x;
    const n = this.curve.length;
    const p = (Math.max(-1, Math.min(1, x)) + 1) / 2 * (n - 1);
    const i0 = Math.floor(p), f = p - i0;
    return this.curve[i0] * (1 - f) + this.curve[Math.min(n - 1, i0 + 1)] * f;
  }
}

// Direct Form I, RBJ cookbook -- the formulas the WebAudio spec itself specifies.
class Biquad extends Node {
  constructor() { super(); this.type = 'lowpass'; this.frequency = new Param(350); this.Q = new Param(1); this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  calc(i) {
    const f = Math.max(10, Math.min(SR / 2 - 100, this.frequency.at(i)));
    const q = Math.max(1e-4, this.Q.at(i));
    const w = 2 * Math.PI * f / SR, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    if (this.type === 'bandpass') { b0 = al; b1 = 0; b2 = -al; }
    else { const k = 1 - cw; b0 = k / 2; b1 = k; b2 = k / 2; }
    const x = this.sum(i);
    const y = (b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2) / a0;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function makeContext() {
  const dest = new Gain();
  return {
    currentTime: 0, sampleRate: SR, state: 'running', destination: dest, _dest: dest,
    createGain: () => new Gain(),
    createBiquadFilter: () => new Biquad(),
    createOscillator: () => new Oscillator(),
    createWaveShaper: () => new WaveShaper(),
    createBufferSource: () => new BufferSource(),
    createBuffer: (_c, len, sr) => ({ length: len, sampleRate: sr, data: new Float32Array(len), getChannelData() { return this.data; } }),
  };
}

// ---------------------------------------------------------------- run one section
export function render(secs, onFrame, patch = {}, solo = true) {
  const ctx = makeContext();
  global.window = { AudioContext: function () { return ctx; } };
  const a = new GameAudio();
  a.setRail({ ...RAIL_DEFAULTS, ...patch });
  a.railSampleBuffer = loadSample(ctx.createBuffer);
  a.ensure();
  // solo: the grind on its own, so nothing masks what you are judging. Otherwise the whole mix,
  // which is what the headset will actually hand you.
  if (solo) a.railPreview = true;
  const mute = () => { for (const v of [a.wind, a.carve, a.skid, a.rumble]) v.g.gain.value = 0; };

  const n = Math.round(secs * SR), out = new Float32Array(n);
  const step = Math.round(SR / 60);
  let wasOn = 0;
  for (let i = 0; i < n; i++) {
    if (i % step === 0) {
      ctx.currentTime = i / SR;
      const f = { grounded: true, onRail: 1, carving: 0, skidding: 0, ...onFrame(i / SR, secs) };
      // Same edge the game watches, so the knocks land where they really would.
      if (f.onRail !== wasOn) { if (f.onRail) a.railOn(); else a.railOff(); wasOn = f.onRail; }
      a.update(1 / 60, f);
      if (solo) mute();
    }
    out[i] = ctx._dest.out(i);
  }
  return out;
}

// The common case: the grind on its own, steady, so it can be measured or compared.
export function renderSolo(secs = 4, patch = {}, speed = 12) {
  return render(secs, () => ({ speed }), patch, true);
}
