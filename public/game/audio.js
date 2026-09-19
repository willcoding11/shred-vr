// Procedural sound: wind, edge carve / skid noise and a few one-shots. No assets needed.
export class GameAudio {
  constructor() { this.ctx = null; this.enabled = true; this.volume = 0.8; }
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
  }
  update(dt, { speed = 0, carving = 0, skidding = 0, grounded = true, tuck = 0 } = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime, tc = 0.08;
    const s = Math.min(1, speed / 28);
    this.wind.g.gain.setTargetAtTime(0.02 + s * s * 0.5 * (1 - tuck * 0.3), t, tc);
    this.wind.f.frequency.setTargetAtTime(250 + s * 1600, t, tc);
    this.carve.g.gain.setTargetAtTime(grounded ? carving * Math.min(1, speed / 12) * 0.16 : 0, t, tc);
    this.carve.f.frequency.setTargetAtTime(1200 + speed * 40, t, tc);
    this.skid.g.gain.setTargetAtTime(grounded ? skidding * Math.min(1, speed / 10) * 0.3 : 0, t, tc);
    this.rumble.g.gain.setTargetAtTime(grounded ? Math.min(1, speed / 20) * 0.35 : 0, t, tc);
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
