// Turns a recorded clip into something that can be looped forever without ticking.
//
// A sample dropped into a loop joins its own end to its own start, and those two moments have no
// reason to match -- you hear a click, or worse a pulse once a cycle that the ear locks onto and
// then cannot unhear. This crossfades the tail back over the head so the join is continuous, and
// picks the fade length by trying several and keeping whichever leaves the smallest discontinuity.
//
//   node tools/make-loop.mjs in.wav out.wav [--keep-stereo]
import { readFileSync, writeFileSync } from 'node:fs';

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
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM');
  const frames = Math.floor(data.size / 2 / fmt.ch);
  const chans = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.ch; c++) chans[c][i] = b.readInt16LE(data.at + (i * fmt.ch + c) * 2) / 32768;
  }
  return { chans, sr: fmt.sr };
}

function writeWav(path, chans, sr) {
  const ch = chans.length, n = chans[0].length, bytes = n * ch * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * ch * 2, 28); b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      b.writeInt16LE(Math.round(v * 32767), 44 + (i * ch + c) * 2);
    }
  }
  writeFileSync(path, b);
  return bytes + 44;
}

// How badly the join would be heard: the step at the seam, plus how much the signal's own slope
// jumps there. A pure level match is not enough -- a kink is audible too.
function seamError(chans) {
  let e = 0;
  for (const d of chans) {
    const n = d.length;
    const step = d[0] - d[n - 1];
    const slopeIn = d[n - 1] - d[n - 2], slopeOut = d[1] - d[0];
    e += step * step + 0.5 * (slopeOut - slopeIn) ** 2;
  }
  return Math.sqrt(e / chans.length);
}

function loopify(chans, fade) {
  const n = chans[0].length, L = n - fade;
  return chans.map((d) => {
    const out = d.slice(0, L);
    for (let j = 0; j < fade; j++) {
      // Equal-power, so the crossfade does not dip in the middle the way a linear one does.
      const t = j / fade, a = Math.cos(t * Math.PI / 2), b = Math.sin(t * Math.PI / 2);
      out[j] = d[j] * b + d[L + j] * a;
    }
    return out;
  });
}

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node tools/make-loop.mjs in.wav out.wav [--keep-stereo]'); process.exit(1); }

let { chans, sr } = readWav(inPath);
console.log(`in:  ${chans.length}ch ${sr} Hz ${(chans[0].length / sr).toFixed(2)}s`);

if (!process.argv.includes('--keep-stereo') && chans.length > 1) {
  // The grind comes from under your own feet, so it has no business being wide.
  const n = chans[0].length, mono = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const d of chans) s += d[i]; mono[i] = s / chans.length; }
  chans = [mono];
  console.log('     mixed to mono');
}

const before = seamError(chans);
let best = null;
for (const ms of [40, 80, 150, 250, 400, 600]) {
  const fade = Math.round(sr * ms / 1000);
  if (fade * 3 > chans[0].length) continue;
  const cand = loopify(chans, fade);
  const err = seamError(cand);
  console.log(`     ${String(ms).padStart(3)} ms fade -> seam ${err.toExponential(2)}`);
  if (!best || err < best.err) best = { err, cand, ms };
}
if (!best) throw new Error('clip too short to loop');

writeWav(outPath, best.cand, sr);
console.log(`\nout: ${best.cand.length}ch ${(best.cand[0].length / sr).toFixed(2)}s, ${best.ms} ms crossfade`);
console.log(`seam discontinuity ${before.toExponential(2)} -> ${best.err.toExponential(2)}`
  + `  (${(before / best.err).toFixed(0)}x smaller)`);
