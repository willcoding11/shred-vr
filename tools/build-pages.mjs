// Build the static, server-less copy of the GAME for GitHub Pages.
//
//   node tools/build-pages.mjs [outDir]      (default: dist/pages)
//
// What the dev server provides, and what stands in for it here:
//   /vendor/three, /vendor/jsm   -> vendor/ copied out of node_modules (only the files the game uses)
//   /api/maps                    -> maps/index.json, the same list the server builds
//   /api/maps/<id>               -> maps/<id>.json
//   the /ws live-edit socket     -> nothing; the game sees github.io and does not open one
// The editor and the mixer need the server to be any use, so they are left out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist/pages'));
const SKIP_PUBLIC = new Set(['editor', 'mixer', 'index.html']);

// Refuse to empty anything that does not look like a build folder of ours.
if (fs.existsSync(OUT)) {
  const left = fs.readdirSync(OUT).filter((f) => f !== '.git');
  if (left.length && !fs.existsSync(path.join(OUT, '.shred-pages'))) {
    console.error(`${OUT} is not empty and is not a previous build; not touching it`);
    process.exit(1);
  }
  for (const f of left) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
}
fs.mkdirSync(OUT, { recursive: true });
const copy = (from, to) => fs.cpSync(from, path.join(OUT, to), { recursive: true });

// public/, minus the server-only pages
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
  if (!SKIP_PUBLIC.has(f)) copy(path.join(ROOT, 'public', f), f);
}

// three.js: the core module, plus every examples/jsm file the shared code imports (and theirs)
const THREE = path.join(ROOT, 'node_modules/three');
copy(path.join(THREE, 'build/three.module.js'), 'vendor/three/three.module.js');
const JSM = path.join(THREE, 'examples/jsm');
const want = new Set();
const scan = (src, fromJsm) => {
  for (const m of src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
    let rel = null;
    if (m[1].startsWith('three/addons/')) rel = m[1].slice('three/addons/'.length);
    else if (fromJsm && m[1].startsWith('.')) rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromJsm), m[1]));
    if (!rel || want.has(rel)) continue;
    want.add(rel);
    scan(fs.readFileSync(path.join(JSM, rel), 'utf8'), rel);
  }
};
for (const dir of ['public/game', 'public/shared']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (f.endsWith('.js')) scan(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), null);
  }
}
for (const rel of want) copy(path.join(JSM, rel), path.join('vendor/jsm', rel));

// maps, and the list the server would have served from /api/maps
const MAPS = path.join(ROOT, 'maps');
fs.mkdirSync(path.join(OUT, 'maps'), { recursive: true });
const list = [];
for (const f of fs.readdirSync(MAPS)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  const m = JSON.parse(fs.readFileSync(path.join(MAPS, f), 'utf8'));
  copy(path.join(MAPS, f), path.join('maps', f));
  list.push({ id: m.id, name: m.name, difficulty: m.difficulty || 'green', size: m.size, spacing: m.spacing,
    props: (m.props || []).length, order: m.order ?? 100, description: m.description || '' });
}
list.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
let active = null;
try { active = JSON.parse(fs.readFileSync(path.join(MAPS, '_state.json'), 'utf8')).activeMap || null; } catch {}
fs.writeFileSync(path.join(OUT, 'maps/index.json'), JSON.stringify({ active, maps: list }, null, 2));

// the front door goes straight to the game
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Shred VR</title>
<meta http-equiv="refresh" content="0; url=game/" />
<link rel="icon" href="favicon.svg" type="image/svg+xml" />
</head><body style="background:#0b1220;color:#f1f5f9;font-family:system-ui,sans-serif">
<p><a href="game/" style="color:#38bdf8">Play Shred VR</a></p>
<script>location.replace('game/' + location.search + location.hash);</script>
</body></html>
`);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(path.join(OUT, '.shred-pages'), 'output of tools/build-pages.mjs\n');

console.log(`static game built in ${OUT}: ${list.length} maps, ${want.size} three.js addon files`);
