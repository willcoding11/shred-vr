// A bench for the rail grind, off to one side of the game.
//
// Dialling a procedural sound in from source edits is hopeless: you change a number, reload, ride
// to a rail, and by the time you hear it you have forgotten what the last one sounded like. This
// runs the same GameAudio the game runs, holds the grind on, and puts every parameter under a
// slider. It imports the real audio module rather than copying the graph, so what you hear here
// is what the game plays -- a mixer tuning its own private copy would be worse than no mixer.
import { GameAudio, RAIL_DEFAULTS, SYNTH_ONLY } from '../game/audio.js';

const $ = (id) => document.getElementById(id);
const audio = new GameAudio();
let playing = false;

// Rows are [key, label, min, max, step, unit, hint].
const GRIND = [
  {
    title: 'The recording',
    note: 'The grind is a looped capture now. It still gets the velocity trick the synth was '
        + 'built around: going faster plays the loop faster, so speed moves the timbre and not '
        + 'only the volume. A recording pitches as it speeds up, though, so Speed to pitch is an '
        + 'exponent rather than a multiplier - 1.0 is literal tape speed and sounds like it. The '
        + 'synth underneath is all still here, at zero; the presets bring it back.',
    rows: [
      ['sampleGain', 'Recording level', 0, 0.4, 0.005, '', 'set against the wind at riding speed'],
      ['sampleTrack', 'Speed to pitch', 0, 1.2, 0.01, '', '0 pins it, 1 is tape speed'],
    ],
  },
  {
    title: 'The surface you are crossing',
    note: 'A scrape is not filtered noise, it is a run of tiny impacts as the base crosses the '
        + 'roughness of the steel. These describe that surface. Speed to pitch is the one that '
        + 'decides whether it reads as a scrape at all: turn it to 0 and the hiss comes back.',
    rows: [
      ['grain', 'Catch rate', 40, 6000, 20, '/s', 'sparse is a chatter, dense is a scrape'],
      ['rough', 'Roughness', 0, 3, 0.02, '', 'the texture between the catches'],
      ['drive', 'Bite', 0.1, 12, 0.1, '', 'soft scuff through to a hard scrape with teeth in it'],
      ['rateScale', 'Speed to pitch', 0, 3, 0.05, '', 'how much going faster lifts the whole sound'],
    ],
  },
  {
    title: 'The base on the metal',
    note: 'The broadband part. Plastic sliding on steel, no note to it.',
    rows: [
      ['hissFreq', 'Hiss pitch', 600, 8000, 25, 'Hz', ''],
      ['hissQ', 'Hiss focus', 0.3, 20, 0.1, '', 'low is a wash, high is a whistle'],
      ['hissGain', 'Hiss level', 0, 0.6, 0.005, '', ''],
    ],
  },
  {
    title: 'The bar',
    note: 'Four partials ringing off the scrape. A steel bar does not ring in harmonics -- a bar '
        + 'free at both ends sits at 1 : 2.76 : 5.40 : 8.93 -- and that inharmonic spacing is most '
        + 'of why metal sounds like metal. Bar stretch runs from a pipe at 1.0, through a steel '
        + 'bar around 1.55, to a bell at 2.0.',
    rows: [
      ['ringFreq', 'Bar pitch', 80, 1600, 5, 'Hz', 'the first partial'],
      ['ringSpread', 'Bar stretch', 1, 2.2, 0.01, '', 'pipe, bar, bell'],
      ['ringQ', 'Bar ring', 1, 40, 0.5, '', 'how long each partial holds'],
      ['ringGain', 'Bar level', 0, 0.6, 0.005, '', ''],
      ['ringTilt', 'Bar tilt', 0, 1.5, 0.01, '', 'how fast the upper partials fall away'],
    ],
  },
  {
    title: 'The board',
    note: 'Two things are scraping, not one. The paper sums the surface\'s resonance with the '
        + 'scraper\'s own, and dropping the second is one of the ablations it tests -- ours only '
        + 'ever had the rail. A snowboard deck measures 16 / 37 / 65 Hz in bending, free-free, so '
        + 'what it adds is a low thrum rather than a ring. Fair warning: the first two modes sit '
        + 'under what the headset speakers can reproduce, so this is worth much more on '
        + 'headphones, and you may want to push the pitch up for the Quest. Free decks damp at '
        + '0.3-1% (Q 50 to 170); bindings raise that two to three times over, so strapped in it is '
        + 'nearer Q 30.',
    rows: [
      ['boardFreq', 'Board pitch', 10, 220, 1, 'Hz', 'first bending mode; 16 is the measured one'],
      ['boardQ', 'Board ring', 2, 120, 1, '', 'free deck is 50 to 170, strapped in nearer 30'],
      ['boardGain', 'Board level', 0, 0.5, 0.005, '', 'how much of it you hear against the rail'],
    ],
  },
  {
    title: 'How hard you lean on it',
    note: 'The load and unload of a real scrape, and the thing that was missing. Measured against '
        + 'the demos from the paper, their full model swings its loudness by about 47% at 0.7 Hz '
        + 'while its spectrum sits still; ours swung 13% at 13 Hz, which is where their weakest '
        + 'baseline sits too. Pressing harder does not only get louder, it drives the contact '
        + 'further into the soft clip, so it gets more bite at the same time. Set Press to 0 and '
        + 'you are listening to their "no normal force" ablation.',
    rows: [
      ['press', 'Press', 0, 1, 0.01, '', 'how deeply it loads and unloads'],
      ['pressRate', 'Press rate', 0.05, 5, 0.05, 'Hz', 'how often'],
      ['tilt', 'Damping', 400, 16000, 100, 'Hz', 'the surface arrives 6 dB an octave bright; this tips it back'],
    ],
  },
  {
    title: 'Movement',
    note: 'Nothing about a real grind holds still.',
    rows: [
      ['lfoRate', 'Wobble speed', 0, 40, 0.1, 'Hz', 'the bar is not straight'],
      ['lfoDepth', 'Wobble depth', 0, 500, 5, 'Hz', ''],
      ['flutter', 'Flutter', 0, 1, 0.01, '', 'the fast chatter over the slow load'],
      ['clackFreq', 'Clack pitch', 60, 600, 5, 'Hz', 'the knock on and off the steel'],
      ['speedRef', 'Full at', 2, 25, 0.5, 'm/s', 'the speed everything above is measured against'],
    ],
  },
];

// Somewhere to start from, rather than eighteen sliders and a blank stare.
const PRESETS = {
  'Recording': {},
  'Recording + board thrum': { boardGain: 0.14 },
  'Synth only (no recording)': SYNTH_ONLY,
  'Synth, steel rail': { ...SYNTH_ONLY },
  'Synth, plastic box': { ...SYNTH_ONLY, grain: 2600, rough: 1.4, drive: 1.2, ringFreq: 190, ringSpread: 1.25,
                   ringQ: 5, ringGain: 0.05, ringTilt: 0.9, hissFreq: 1700, hissQ: 0.9,
                   hissGain: 0.22, tilt: 2200, lfoDepth: 25, flutter: 0.35 },
  'Synth, chattery': { ...SYNTH_ONLY, grain: 150, rough: 0.2, drive: 7, ringQ: 30, ringGain: 0.22, ringTilt: 0.35,
                lfoRate: 13, lfoDepth: 140, flutter: 0.6, pressRate: 3.2 },
  'Synth, fast and smooth': { ...SYNTH_ONLY, grain: 5500, rough: 1.1, drive: 1.6, rateScale: 1.4, ringQ: 9,
                       ringGain: 0.1, hissFreq: 4600, hissGain: 0.2, tilt: 6000,
                       press: 0.4, flutter: 0.1 },
  // Conditions from the paper, so you can hear what each piece does the way their demo page lets
  // you. The normal-force swell is NOT what ships: it models a hand stroking back and forth, and a
  // board sliding a rail at speed is a steady contact -- it sounded like sawing at it.
  'Their: with normal force': { press: 0.9 },
  'Their: no non-linearity': { drive: 0.1 },
  'Their: no board': { boardGain: 0 },
  'Board up for headset speakers': { boardFreq: 75, boardGain: 0.16 },
};

// Not part of the sound, but part of hearing it honestly.
const cond = { speed: 12, tuck: 0 };
const CONDS = [
  ['speed', 'Speed', 0, 30, 0.5, 'm/s', 'the grind and the wind both ride on this'],
  ['tuck', 'Tuck', 0, 1, 0.05, '', 'how folded over the board you are'],
];

const controls = new Map();

function slider(host, obj, [key, label, min, max, step, unit, hint], onChange) {
  const l = document.createElement('label');
  l.className = 'slider';
  l.dataset.key = key;
  l.innerHTML = `<span class="name">${label}${hint ? ` <em>${hint}</em>` : ''}</span><output></output>`;
  const input = document.createElement('input');
  input.type = 'range'; input.min = min; input.max = max; input.step = step;
  const out = l.querySelector('output');
  const show = () => { out.textContent = `${+obj[key].toFixed(4)}${unit ? ' ' + unit : ''}`; };
  input.value = obj[key];
  show();
  input.addEventListener('input', () => { obj[key] = Number(input.value); show(); onChange(key); });
  l.appendChild(input);
  host.appendChild(l);
  return { input, show };
}

// The grind sliders write straight into audio.rail, but still go through setRail, because some of
// them have work hanging off them: the surface has to be rebaked, the soft clip recomputed.
const touched = (key) => { audio.setRail({ [key]: audio.rail[key] }); dump(); };

for (const group of GRIND) {
  const sec = document.createElement('div');
  sec.className = 'group';
  sec.innerHTML = `<h3>${group.title}</h3><p class="note">${group.note}</p>`;
  const grid = document.createElement('div');
  grid.className = 'grid';
  sec.appendChild(grid);
  $('grid').appendChild(sec);
  for (const spec of group.rows) controls.set(spec[0], slider(grid, audio.rail, spec, touched));
}
CONDS.forEach((spec) => slider($('conds'), cond, spec, () => {}));

// The one non-numeric knob. It belongs with the grind rather than the conditions, because whether
// the snow keeps playing underneath changes what the grind sounds like.
$('duck').checked = audio.rail.duck !== false;
$('duck').addEventListener('change', (e) => { audio.setRail({ duck: e.target.checked }); dump(); });

for (const name of Object.keys(PRESETS)) {
  const b = document.createElement('button');
  b.className = 'btn'; b.textContent = name;
  b.addEventListener('click', () => { apply({ ...RAIL_DEFAULTS, ...PRESETS[name] }); say(`${name}.`); });
  $('presets').appendChild(b);
}

function apply(settings) {
  audio.setRail({ ...settings });
  for (const [key, c] of controls) { c.input.value = audio.rail[key]; c.show(); }
  $('duck').checked = audio.rail.duck !== false;
  dump();
}

function dump() {
  $('out').textContent = JSON.stringify(audio.rail, null, 2);
}
dump();

// The game calls audio.update every frame with what the rider is doing; so does this, with what
// the Conditions sliders say instead.
function tick() {
  if (playing) {
    audio.update(1 / 60, {
      speed: cond.speed, carving: 0.5, skidding: 0.15,
      grounded: true, tuck: cond.tuck, onRail: 1,
    });
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

$('btnPlay').addEventListener('click', () => {
  playing = !playing;
  // An AudioContext will not start without a gesture, which is what this button is really for.
  audio.previewRail(playing);
  if (!playing) audio.update(1 / 60, { speed: 0, grounded: false, onRail: 0 });
  $('btnPlay').textContent = playing ? 'Stop' : 'Start the grind';
  $('btnPlay').classList.toggle('primary', !playing);
});

for (const b of document.querySelectorAll('[data-shot]')) {
  b.addEventListener('click', () => {
    audio.ensure();
    const fn = b.dataset.shot;
    if (fn === 'land') audio.land(6);
    else if (typeof audio[fn] === 'function') audio[fn]();
  });
}

$('btnReset').addEventListener('click', () => {
  apply(RAIL_DEFAULTS);
  say('Back to the defaults the game ships with.');
});

$('btnCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('out').textContent);
    say('Copied. Paste it to me and I will make it the default.');
  } catch {
    say('Could not reach the clipboard - select the text above instead.');
  }
});

let sayT = null;
function say(t) {
  $('status').textContent = t;
  clearTimeout(sayT);
  sayT = setTimeout(() => { $('status').textContent = ''; }, 4000);
}
