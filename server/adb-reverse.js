// Forwards the headset's localhost:8080/8443 to this PC so the Quest browser gets a
// secure context (WebXR needs https OR localhost) without any certificate warning.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cands = [
  process.env.ADB,
  'C:/Users/willi/.bubblewrap/android_sdk/platform-tools/adb.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs/SideQuest/resources/app.asar.unpacked/build/platform-tools/adb.exe'),
  'adb',
].filter(Boolean);
const adb = cands.find((c) => c === 'adb' || fs.existsSync(c));
const run = (...a) => execFileSync(adb, a, { stdio: 'pipe' }).toString();

try {
  run('devices'); // first call may only start the daemon
  const out = run('devices');
  const devs = out.split('\n').slice(1).filter((l) => l.trim().endsWith('device'));
  if (!devs.length) {
    console.log('No headset found over adb. Plug it in (or run: adb connect <headset-ip>:5555), then retry.');
    process.exit(1);
  }
  for (const p of [8080, 8443]) run('reverse', `tcp:${p}`, `tcp:${p}`);
  console.log('Reversed ports 8080 and 8443. On the headset open:  http://localhost:8080/game/');
} catch (e) {
  console.error('adb failed:', e.message);
  process.exit(1);
}
