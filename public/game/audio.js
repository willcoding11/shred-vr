// Procedural sound: wind, edge carve / skid noise and a few one-shots. No assets needed.
// Everything about the rail grind, in one place and changeable while it plays. Grinding is the
// one sound here with no real-world reference in the project -- it has to be dialled in by ear --
// so it is exposed rather than buried in the graph.
export const RAIL_DEFAULTS = {
  // A recording of the real thing, looped. The synth below still works and is a click away in
  // the mixer, but a 2-second capture carries texture no amount of filtered noise will reach.
  // It keeps the velocity trick the synth taught us: crossing the surface faster plays the loop
  // faster, so speed moves the timbre and not just the volume. sampleTrack is the exponent on
  // that -- 1 is literal tape speed, which pitches too hard to believe, so it ships well under.
  sampleGain: 0.10,
  sampleTrack: 0.45,
  // The surface you are crossing. Scraping is a dense train of micro-impacts as the base rides
  // over the asperities of the steel -- these describe that surface, and changing them rebakes it.
  grain: 4500,       // asperities per second: sparse is a chatter, dense is a scrape
  rough: 0.55,       // broadband roughness underneath the asperities
  drive: 4.0,        // soft-clip. Low is a polite scuff, high is a scrape with teeth in it
  rateScale: 1.0,    // how hard speed shifts the read rate -- 0 puts the old hiss back
  // The base over the metal.
  hissFreq: 3200,
  hissQ: 1.6,
  hissGain: 0,
  // The bar itself. A steel bar does not ring in harmonics, so ringSpread stretches the partials:
  // 1.0 is a pipe, 1.55 is the closest power law to a free-free steel bar, 2.0 is a bell.
  ringFreq: 430,
  ringSpread: 1.55,
  ringQ: 16,
  ringGain: 0,
  ringTilt: 0.55,    // how fast the upper partials fall away
  // The board. Two things are scraping, not one: the paper's full model sums the surface's
  // resonance and the scraper's own, and dropping the second is one of the ablations they test.
  // Ours only ever had the rail. A snowboard deck measures 16 / 37 / 65 Hz in bending and 30 / 54
  // / 86 Hz in torsion, free-free, so its contribution is a low thrum rather than a ring -- and
  // note the first two sit under what the Quest's own speakers can reproduce, so this is worth
  // more on headphones. Free decks damp at 0.3-1% (Q 50-170); bindings raise that by 200-330%,
  // which is why strapped in it is nearer Q 30.
  boardFreq: 16,     // first bending mode; the rest follow the measured 1 : 2.31 : 4.06
  boardQ: 30,
  boardGain: 0,      // their eta: how much of the board you hear against the rail
  // How hard you are leaning on it. Measuring the demos from the paper against ours, this was
  // the whole gap: their full model swings its loudness by ~47% at about 0.7 Hz while its spectrum
  // sits still, and ours swung 13% at 13 Hz. A scrape loads and unloads over about a second, and
  // pressing harder does not only get louder -- it drives the contact further into the soft clip,
  // so it gets more bite at the same time. That coupling is what their "no normal force" drops.
  press: 0,          // depth of the load and unload
  pressRate: 1.6,    // how often, in cycles a second
  tilt: 3200,        // Hz. The differentiator tilts the surface up 6 dB an octave; this tips it back
  // Motion.
  lfoRate: 7.5,      // a rail is never perfectly smooth under you
  lfoDepth: 60,
  flutter: 0.18,     // the fast chatter on top of the slow load
  speedRef: 9,       // how fast you have to be going for the full sound
  clackFreq: 210,    // the knock as the board finds the steel, and again as it leaves
  duck: true,        // pull the snow out from under the grind; both at once reads as neither
};

// Smooth random wander, baked small and resampled by the graph: nothing in it goes above about
// 30 Hz, so at the context rate it would be a quarter of a million samples of nothing.
function slowNoise(ctx, hz, secs) {
  const sr = 8000, len = sr * secs, buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0), step = Math.max(1, Math.floor(sr / hz));
  let prev = 0, next = Math.random() * 2 - 1, k = 0, peak = 0;
  for (let i = 0; i < len; i++) {
    if (k === 0) { prev = next; next = Math.random() * 2 - 1; }
    const u = k / step;
    d[i] = prev + (next - prev) * u * u * (3 - 2 * u);
    if (++k >= step) k = 0;
    if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
  }
  if (peak > 0) for (let i = 0; i < len; i++) d[i] /= peak;
  return buf;
}

// What the grind was before the recording went in: the procedural model, on its own. Kept as a
// named thing because it is the fallback if the sample will not load -- a missing asset should
// cost you the texture, not the sound -- and because the mixer offers it as a preset.
export const SYNTH_ONLY = { sampleGain: 0, hissGain: 0.40, ringGain: 0.40, boardGain: 0.24 };

export const RAIL_SAMPLE_URL = '/assets/audio/rail-grind.ogg';

// Bending modes of a snowboard deck, as measured: 16, 37 and 65 Hz, free-free.
const BOARD_MODES = [1, 37 / 16, 65 / 16];

// Soft clip for the friction force. The scraping literature puts a tanh on the contact force
// because a real scraper cannot follow every peak of the surface -- bounded force means bounded
// curvature -- and that clipping is most of what separates a scrape from a wash.
function tanhCurve(drive) {
  const n = 1024, c = new Float32Array(n), k = Math.max(0.01, drive), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1)) / norm;
  return c;
}

export class GameAudio {
  constructor() { this.ctx = null; this.enabled = true; this.volume = 0.8; this.rail = { ...RAIL_DEFAULTS }; }
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain(); this.master.gain.value = this.volume; this.master.connect(ctx.destination);
    // shared noise source
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource(); this.noise.buffer = buf; this.noise.loop = true; this.noise.start();
    const mk = (type, freq, q) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; this.noise.connect(f); f.connect(g); g.connect(this.master); return { f, g }; };
    this.wind = mk('lowpass', 300, 0.7);
    this.carve = mk('bandpass', 1500, 1.2);
    this.skid = mk('bandpass', 420, 0.9);
    this.rumble = mk('lowpass', 90, 1.0);
    // Riding a box does not sound like riding snow, and it is not a filtered hiss either. Steady
    // noise has a stationary spectrum, which is why it reads as wind however you filter it. A
    // scrape is a dense train of micro-impacts, and their rate rises with how fast you are moving.
    // So: bake a surface profile once, read it at a rate set by speed, soft-clip it for the grit,
    // and let the bar ring off it. Reading a fixed profile faster is how the contact-sound papers
    // get velocity into the timbre rather than only into the volume.
    const R = this.rail;
    // railBus just sums the synth voices; railOut carries the envelope that everything on the
    // rail shares -- speed, flutter, press, the duck. The tilt filter sits between them because it
    // exists to tame the synth's differentiator, and the recording has no need of it.
    this.railBus = ctx.createGain(); this.railBus.gain.value = 1;
    this.railTilt = ctx.createBiquadFilter();
    this.railTilt.type = 'lowpass'; this.railTilt.frequency.value = R.tilt; this.railTilt.Q.value = 0.6;
    this.railOut = ctx.createGain(); this.railOut.gain.value = 0;
    this.railBus.connect(this.railTilt); this.railTilt.connect(this.railOut);
    this.railOut.connect(this.master);
    this.railSampleGain = ctx.createGain(); this.railSampleGain.gain.value = 0;
    this.railSampleGain.connect(this.railOut);
    this.startSample();
    this.railShape = ctx.createWaveShaper(); this.railShape.curve = tanhCurve(R.drive);
    this.railPre = ctx.createGain(); this.railPre.gain.value = 1;
    this.railPre.connect(this.railShape);
    this.railSurface = null;
    this.bakeSurface();

    const railFilt = (freq, q, gain) => {
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gain;
      this.railShape.connect(f); f.connect(g); g.connect(this.railBus);
      return { f, g };
    };
    this.railHiss = railFilt(R.hissFreq, R.hissQ, R.hissGain);
    // Four partials, stretched by ringSpread. A free-free steel bar rings at 1 : 2.76 : 5.40 :
    // 8.93 -- nothing like a harmonic series, which is exactly why metal sounds like metal.
    this.railModes = [];
    for (let n = 1; n <= 4; n++) {
      this.railModes.push(railFilt(R.ringFreq * Math.pow(n, R.ringSpread), R.ringQ,
                                   R.ringGain * Math.pow(n, -R.ringTilt * 2)));
    }
    // The board under you, ringing off the same scrape. Measured ratios, not a bar series --
    // a deck is tapered and cambered, so it comes out flatter than a uniform beam would.
    this.railBoard = BOARD_MODES.map((m) => railFilt(R.boardFreq * m, R.boardQ, 0));

    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = R.lfoRate;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = R.lfoDepth;
    lfo.connect(lfoGain); lfoGain.connect(this.railModes[0].f.frequency); lfo.start();
    this.railLfo = lfo; this.railLfoGain = lfoGain;

    // The contact wanders -- weight shifts, the rail is not straight. Fast chatter on the bus.
    const fsrc = ctx.createBufferSource(); fsrc.buffer = slowNoise(ctx, 9, 4); fsrc.loop = true; fsrc.start();
    this.railFlutter = ctx.createGain(); this.railFlutter.gain.value = 0;
    fsrc.connect(this.railFlutter); this.railFlutter.connect(this.railOut.gain);

    // And underneath that, the slow load and unload of leaning on it. It goes two places: the
    // level, and the gain into the soft clip -- which is the same thing as driving the clip
    // harder, so leaning on the rail gets louder and gets more bite together.
    const psrc = ctx.createBufferSource();
    psrc.buffer = slowNoise(ctx, 1, 8); psrc.loop = true;
    psrc.playbackRate.value = R.pressRate; psrc.start();
    this.railPress = psrc;
    this.railPressBite = ctx.createGain(); this.railPressBite.gain.value = 0;
    this.railPressLvl = ctx.createGain(); this.railPressLvl.gain.value = 0;
    psrc.connect(this.railPressBite); this.railPressBite.connect(this.railPre.gain);
    psrc.connect(this.railPressLvl); this.railPressLvl.connect(this.railOut.gain);
  }

  // The recording. ensure() is synchronous and this is not, so the loop simply joins in when it
  // arrives; until then the rail is whatever the synth voices are set to. Tools that run outside a
  // browser pre-seed railSampleBuffer and skip the fetch entirely.
  startSample() {
    const ctx = this.ctx;
    const attach = (buf) => {
      if (!buf || !this.ctx) return;
      this.railSampleBuffer = buf;
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true; src.playbackRate.value = 1;
      src.connect(this.railSampleGain); src.start();
      this.railSample = src;
    };
    if (this.railSampleBuffer) { attach(this.railSampleBuffer); return; }
    // A relative URL needs a page to be relative to. Node has fetch but no location, and would
    // only hand back a rejected promise a tick later -- decide here instead, while it still helps.
    if (typeof fetch !== 'function' || typeof location === 'undefined') { this.sampleFailed(); return; }
    fetch(RAIL_SAMPLE_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((b) => ctx.decodeAudioData(b))
      .then(attach)
      .catch((e) => { console.warn('rail sample unavailable, falling back to the synth:', e.message); this.sampleFailed(); });
  }

  // No recording means no grind at all, which is worse than the model it replaced.
  sampleFailed() {
    if (this.rail.sampleGain > 0 && !this.rail.hissGain && !this.rail.ringGain) this.setRail(SYNTH_ONLY);
  }

  // The surface, baked once and then read at whatever rate the rider is going. Rough at every
  // scale like a real one, with discrete asperities on top -- those are the catches you hear.
  bakeSurface() {
    const ctx = this.ctx; if (!ctx) return;
    const R = this.rail, sr = ctx.sampleRate, len = Math.floor(sr * 2);
    const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    let amp = 1, sum = 0;
    for (let oct = 0; oct < 6; oct++) {
      const step = 1 << (6 - oct);
      let prev = 0, next = Math.random() * 2 - 1, k = 0;
      for (let i = 0; i < len; i++) {
        if (k === 0) { prev = next; next = Math.random() * 2 - 1; }
        const u = k / step;
        d[i] += amp * (prev + (next - prev) * u * u * (3 - 2 * u));
        if (++k >= step) k = 0;
      }
      sum += amp; amp *= 0.62;
    }
    const rs = R.rough / (sum || 1);
    for (let i = 0; i < len; i++) d[i] *= rs;
    const n = Math.max(0, Math.round(R.grain * 2));
    for (let j = 0; j < n; j++) {
      const at = Math.floor(Math.random() * (len - 8));
      // Most catches are small and a few are not, which is what gives a scrape its texture.
      const h = (Math.random() * 2 - 1) * (0.4 + Math.random() * Math.random() * 3);
      for (let i = 0; i < 6; i++) d[at + i] += h * Math.exp(-i * 0.9);
    }
    // The loop has to join up or it ticks once a cycle.
    const drift = (d[len - 1] - d[0]) / (len - 1);
    for (let i = 0; i < len; i++) d[i] -= drift * i;
    // Force follows the rate of change of the surface, not its height. Differentiate, wrapping
    // round the loop point so the join stays silent.
    let p = d[len - 1];
    for (let i = 0; i < len; i++) { const v = d[i]; d[i] = v - p; p = v; }
    // Scale against a high percentile, not the single biggest catch. Dividing by the peak lets one
    // freak spike duck the whole surface under it, which measures as a very peaky signal and
    // sounds thin; the soft clip downstream bounds the few that overshoot, which is the same
    // argument the paper makes for having a clip at all. Every 8th sample is plenty to find it.
    const sample = new Float32Array(len >> 3);
    for (let i = 0; i < sample.length; i++) sample[i] = Math.abs(d[i << 3]);
    sample.sort();
    const ref = sample[Math.floor(sample.length * 0.999)] || sample[sample.length - 1];
    const k = ref > 0 ? 0.85 / ref : 0;
    for (let i = 0; i < len; i++) d[i] = Math.max(-1, Math.min(1, d[i] * k));

    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.playbackRate.value = this.railSurface ? this.railSurface.playbackRate.value : 1;
    src.connect(this.railPre); src.start();
    if (this.railSurface) { try { this.railSurface.stop(); this.railSurface.disconnect(); } catch {} }
    this.railSurface = src;
  }
  update(dt, { speed = 0, carving = 0, skidding = 0, grounded = true, tuck = 0, onRail = 0, gust = 0.4 } = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime, tc = 0.08;
    const s = Math.min(1, speed / 28);
    // THE SAME GUST YOU CAN SEE. Standing still on a ridge used to be silent, because every
    // wind term was a function of how fast YOU were going -- so the mountain had weather you
    // could see in the spindrift and the trees and could not hear at all. This is the one signal
    // Scenery hands out, so the lull that drops the plume drops the hiss with it.
    const g = 0.35 + gust * 0.9;
    this.wind.g.gain.setTargetAtTime(0.02 + (0.055 * g) + s * s * 0.5 * (1 - tuck * 0.3) * (0.75 + gust * 0.4), t, tc);
    this.wind.f.frequency.setTargetAtTime(250 + s * 1600 + gust * 220, t, tc);
    this.carve.g.gain.setTargetAtTime(grounded ? carving * Math.min(1, speed / 12) * 0.16 : 0, t, tc);
    this.carve.f.frequency.setTargetAtTime(1200 + speed * 40, t, tc);
    this.skid.g.gain.setTargetAtTime(grounded ? skidding * Math.min(1, speed / 10) * 0.3 : 0, t, tc);
    this.rumble.g.gain.setTargetAtTime(grounded ? Math.min(1, speed / 20) * 0.35 : 0, t, tc);
    // On a rail the snow sounds have to get out of the way, or you hear both at once and it
    // reads as neither.
    const R = this.rail;
    const ref = Math.max(0.5, R.speedRef);
    const on = Math.max(grounded ? onRail : 0, this.railPreview ? 1 : 0);
    const sp = Math.min(1, speed / ref);
    // The one line that turns a hiss into a scrape: cross the surface faster and the micro-impacts
    // arrive faster, so the whole spectrum rises with you instead of only the volume.
    this.railSurface.playbackRate.setTargetAtTime(
      Math.max(0.05, Math.min(6, (speed / ref) * R.rateScale)), t, 0.05);
    // Above the reference speed sp is pinned at 1, but the wind keeps climbing with the square of
    // speed and the tilt filter eats the extra brightness the faster read brings -- so without
    // this the grind quietly loses the mix exactly when you are going fast enough to enjoy it.
    // Half again per doubling above the reference, which is a lot less than the wind gains.
    const lift = 1 + 0.7 * Math.log2(Math.max(1, speed / ref));
    const swing = R.flutter * 0.4 + R.press * 0.85;
    this.railOut.gain.setTargetAtTime(on * sp * lift * Math.max(0.05, 1 - swing), t, 0.03);
    this.railSampleGain.gain.setTargetAtTime(R.sampleGain, t, 0.03);
    if (this.railSample) {
      // Same idea as reading the synth's surface faster, but a recording pitches as it speeds up,
      // so the exponent holds it back to something that still sounds like a board on steel.
      this.railSample.playbackRate.setTargetAtTime(
        Math.max(0.5, Math.min(2, Math.pow(Math.max(0.1, speed / ref), R.sampleTrack))), t, 0.08);
    }
    this.railFlutter.gain.setTargetAtTime(on * sp * R.flutter * 0.4, t, 0.05);
    this.railPressLvl.gain.setTargetAtTime(on * sp * R.press * 0.85, t, 0.05);
    this.railPressBite.gain.setTargetAtTime(on * R.press * 0.9, t, 0.05);
    this.railPress.playbackRate.setTargetAtTime(Math.max(0.02, R.pressRate), t, 0.05);
    this.railTilt.frequency.setTargetAtTime(R.tilt, t, 0.05);
    this.railHiss.g.gain.setTargetAtTime(R.hissGain, t, 0.03);
    this.railHiss.f.frequency.setTargetAtTime(R.hissFreq, t, 0.05);
    this.railHiss.f.Q.setTargetAtTime(R.hissQ, t, 0.05);
    for (let i = 0; i < this.railModes.length; i++) {
      const n = i + 1, m = this.railModes[i];
      m.f.frequency.setTargetAtTime(R.ringFreq * Math.pow(n, R.ringSpread), t, 0.05);
      m.f.Q.setTargetAtTime(R.ringQ, t, 0.05);
      m.g.gain.setTargetAtTime(R.ringGain * Math.pow(n, -R.ringTilt * 2), t, 0.03);
    }
    for (let i = 0; i < this.railBoard.length; i++) {
      const b = this.railBoard[i];
      b.f.frequency.setTargetAtTime(R.boardFreq * BOARD_MODES[i], t, 0.05);
      b.f.Q.setTargetAtTime(R.boardQ, t, 0.05);
      // The deck is broad and low, so the upper modes fall away gently rather than steeply.
      b.g.gain.setTargetAtTime(R.boardGain / (1 + i * 0.6), t, 0.03);
    }
    if (this.railLfo) {
      this.railLfo.frequency.setTargetAtTime(R.lfoRate, t, 0.05);
      this.railLfoGain.gain.setTargetAtTime(R.lfoDepth, t, 0.05);
    }
    if (on > 0.5 && R.duck) {
      this.carve.g.gain.setTargetAtTime(0, t, 0.03);
      this.skid.g.gain.setTargetAtTime(0, t, 0.03);
      // The rumble is the board working over snow, and on a rail there is no snow under you. It
      // was being left running, which put it louder than the grind it was supposed to be beneath.
      // What the board itself contributes now comes from its own modes, riding the scrape.
      this.rumble.g.gain.setTargetAtTime(0, t, 0.03);
    }
  }

  // The clack as the board finds the steel, and again as it leaves.
  railOn() { this.tone(this.rail.clackFreq, 0.05, 'square', 0.10); this.burst(2600, 0.07, 0.10); }
  railOff() { this.burst(1800, 0.05, 0.07); }

  // Hold the grind on at full strength so it can be dialled in standing still.
  previewRail(on) { this.ensure(); this.railPreview = !!on; if (on) this.railOn(); else this.railOff(); }
  setRail(patch) {
    Object.assign(this.rail, patch);
    if (!this.ctx) return;
    if ('drive' in patch) this.railShape.curve = tanhCurve(this.rail.drive);
    if ('grain' in patch || 'rough' in patch) {
      // Rebaking restarts the source, so let the slider settle rather than doing it every tick.
      clearTimeout(this._bakeT);
      this._bakeT = setTimeout(() => this.bakeSurface(), 120);
    }
  }
  tone(freq, dur = 0.12, type = 'sine', gain = 0.25, when = 0) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    const t = ctx.currentTime + when;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  burst(freq, dur, gain) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.value = freq;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    this.noise.connect(f); f.connect(g); g.connect(this.master);
    setTimeout(() => {
      try { this.noise.disconnect(f); f.disconnect(); g.disconnect(); } catch {}
    }, dur * 1000 + 100);
  }
  gate() { this.tone(880, 0.12, 'sine', 0.2); this.tone(1320, 0.18, 'sine', 0.18, 0.09); }
  miss() { this.tone(220, 0.25, 'triangle', 0.15); }
  finish() { [660, 880, 1100, 1320].forEach((f, i) => this.tone(f, 0.35, 'sine', 0.2, i * 0.12)); }
  crash() { this.burst(180, 0.6, 0.9); this.tone(90, 0.4, 'triangle', 0.3); }
  stumble() { this.burst(400, 0.25, 0.4); }
  land(impact = 3) { this.burst(250, 0.2, Math.min(0.8, impact / 8)); }
  jump() { this.burst(900, 0.15, 0.15); }
  dropIn() { this.tone(520, 0.1, 'sine', 0.15); this.tone(780, 0.14, 'sine', 0.15, 0.1); }
}
