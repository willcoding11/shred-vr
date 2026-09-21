// Measures a sound so two of them can be compared by something other than memory.
//
// Built for the grind: when someone says "this one is better", these are the numbers that say what
// "better" consisted of, and they point at which slider to move. It reads 16-bit wavs and can also
// take the game's own synth, so a reference and our attempt land side by side in one table.
//
//   node tools/analyse-audio.mjs ref.wav other.wav            compare files
//   node tools/analyse-audio.mjs ref.wav --ours               and our synth at its current defaults
//   node tools/analyse-audio.mjs ref.wav --ours=drive:8,tilt:6000
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// ---------------------------------------------------------------- reading
function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${path}: not a RIFF file`);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = { at: p + 8, size: Math.min(size, b.length - p - 8) };
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: no fmt/data chunk`);
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${path}: only 16-bit PCM, got format ${fmt.format} / ${fmt.bits} bit`);
  const frames = Math.floor(data.size / 2 / fmt.ch), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) s += b.readInt16LE(data.at + (i * fmt.ch + c) * 2) / 32768;
    out[i] = s / fmt.ch;
  }
  return { d: out, sr: fmt.sr };
}

// ---------------------------------------------------------------- measuring
function fft(re, im) {
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
}

export const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export function analyse(d, sr) {
  const N = 1024, H = 512;
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  let pk = 0, s2 = 0;
  for (const v of d) { const a = Math.abs(v); if (a > pk) pk = a; s2 += v * v; }
  const rms = Math.sqrt(s2 / d.length);

  const env = [], cen = [], band = new Float64Array(BANDS.length);
  let flatSum = 0, flatN = 0;
  for (let p = 0; p + N <= d.length; p += H) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = d[p + i] * w[i];
    fft(re, im);
    let e = 0, num = 0, logSum = 0, linSum = 0, bins = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]), f = k * sr / N;
      e += m; num += m * f;
      const pw = m * m + 1e-20;
      logSum += Math.log(pw); linSum += pw; bins++;
      let bi = 0, bd = Infinity;
      for (let j = 0; j < BANDS.length; j++) { const dd = Math.abs(Math.log2(f / BANDS[j])); if (dd < bd) { bd = dd; bi = j; } }
      if (bd <= 0.5) band[bi] += pw;
    }
    env.push(e); cen.push(e > 1e-9 ? num / e : 0);
    // Spectral flatness: 1 is white noise, near 0 is a set of clear resonances.
    if (e > 1e-9) { flatSum += Math.exp(logSum / bins) / (linSum / bins); flatN++; }
  }

  const sortedE = [...env].sort((a, b) => a - b), thr = sortedE[Math.floor(sortedE.length * 0.35)] || 0;
  const keep = env.map((v, i) => [v, cen[i]]).filter(([v]) => v > thr);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const eK = keep.map((k) => k[0]), cK = keep.map((k) => k[1]);

  // Where the loudness moves: the peak of the envelope's own spectrum, below 40 Hz.
  const M = 1024, re = new Float32Array(M), im = new Float32Array(M);
  const eN = env.slice(0, M), em = mean(eN);
  const win = Math.min(M, eN.length);
  for (let i = 0; i < win; i++) re[i] = (eN[i] - em) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / win));
  fft(re, im);
  const fr = sr / H;
  let best = 0, bestf = 0;
  for (let k = 2; k < M / 2; k++) { const f = k * fr / M; if (f > 40) break; const m = Math.hypot(re[k], im[k]); if (m > best) { best = m; bestf = f; } }

  const bTot = band.reduce((x, y) => x + y, 0) || 1;
  return {
    secs: +(d.length / sr).toFixed(2), rms: +rms.toFixed(4), crest: +(pk / rms).toFixed(2),
    centroidHz: Math.round(mean(cK)), centroidWobblePct: +(sd(cK) / mean(cK) * 100).toFixed(1),
    loudnessWobblePct: +(sd(eK) / mean(eK) * 100).toFixed(1), modPeakHz: +bestf.toFixed(1),
    flatness: +(flatSum / Math.max(1, flatN)).toFixed(4),
    bands: [...band].map((v) => +(10 * Math.log10(v / bTot + 1e-12)).toFixed(1)),
  };
}

export function analyseFile(path) {
  const { d, sr } = readWav(path);
  return analyse(d, sr);
}

// ---------------------------------------------------------------- report
// Only when run directly: analyse() is imported by the fitting scripts, which print their own.
const args = process.argv.slice(2);
if (args.length) {
  const rows = [];
  for (const a of args) {
    if (a.startsWith('--ours')) {
      const patch = {};
      const spec = a.split('=')[1];
      if (spec) for (const kv of spec.split(',')) { const [k, v] = kv.split(':'); patch[k] = Number(v); }
      const { renderSolo } = await import('./grind-render-lib.mjs');
      rows.push([spec ? `ours (${spec})` : 'ours (defaults)', analyse(renderSolo(4, patch), 44100)]);
    } else {
      rows.push([basename(a).replace(/\.wav$/i, '').slice(0, 34), analyseFile(a)]);
    }
  }

  const pad = (t, n) => String(t).padEnd(n);
  const num = (t, n) => String(t).padStart(n);
  const W = Math.max(22, ...rows.map((r) => r[0].length + 1));
  const KEYS = [['secs', 'length s'], ['crest', 'crest'], ['centroidHz', 'centroid Hz'],
    ['centroidWobblePct', 'centroid wob %'], ['loudnessWobblePct', 'loudness wob %'],
    ['modPeakHz', 'wobble Hz'], ['flatness', 'flatness']];
  const header = pad('', 16) + rows.map((r) => num(r[0], W)).join('');
  console.log(`\n${header}`);
  for (const [k, label] of KEYS) console.log(pad(label, 16) + rows.map((r) => num(r[1][k], W)).join(''));
  console.log('\nspectrum, dB relative to the whole (flatness: 1.0 is white noise, low is resonant)');
  console.log(header);
  for (let i = 0; i < BANDS.length; i++) {
    const hz = BANDS[i] >= 1000 ? `${BANDS[i] / 1000}k` : `${BANDS[i]}`;
    console.log(pad(`  ${hz} Hz`, 16) + rows.map((r) => num(r[1].bands[i], W)).join(''));
  }
  console.log();
}
