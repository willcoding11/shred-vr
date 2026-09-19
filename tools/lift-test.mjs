// Checks a chairlift is actually rideable: the cable clears the ground the whole way, the seat
// hangs above the snow, the stations sit on the hill, and the ride takes a sane amount of time.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import * as THREE from '../node_modules/three/build/three.module.js';
import { deserializeMap, heightAt } from '../public/shared/mapformat.js';
import { buildLine, cableAt, seatAt, baseNear, unloadSpot, LIFT } from '../public/shared/lifts.js';
const __d = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (n, c, d) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` -- ${d}` : ''}`); if (!c) fail++; };

for (const id of fs.readdirSync(path.join(__d, '..', 'maps')).filter((f) => f.endsWith('.json') && f !== '_state.json')) {
  const map = deserializeMap(fs.readFileSync(path.join(__d, '..', 'maps', id), 'utf8'));
  if (!map.lifts?.length) continue;
  console.log(`\n${map.name}`);
  for (const lift of map.lifts) {
    const line = buildLine(map, lift);
    const v = new THREE.Vector3();
    let minSeat = Infinity, minCable = Infinity, minSeatT = 0;
    for (let k = 0; k <= 400; k++) {
      const t = k / 400;
      seatAt(line, t, v);
      const g = v.y - heightAt(map, v.x, v.z);
      // the first and last few metres are the stations, where the seat is SUPPOSED to be low
      if (t > 0.03 && t < 0.95 && g < minSeat) { minSeat = g; minSeatT = t; }
      cableAt(line, t, 1, v);
      minCable = Math.min(minCable, v.y - heightAt(map, v.x, v.z));
    }
    const drop = line.towers[0].ground - line.towers[line.n].ground;
    console.log(`  ${line.name}: ${line.len.toFixed(0)} m long, ${(-drop).toFixed(0)} m of rise, ${line.n} spans, ${(line.rideTime / 60).toFixed(1)} min`);
    check('the seat never drags on the snow', minSeat > 1.2, `lowest is ${minSeat.toFixed(2)} m at t=${minSeatT.toFixed(2)}`);
    check('and never flies absurdly high', minCable < 60, `closest approach ${minCable.toFixed(1)} m`);
    check('it goes UP the hill', drop < -40, `${(-drop).toFixed(0)} m of rise`);
    check('the ride is a believable length', line.rideTime > 60 && line.rideTime < 480, `${(line.rideTime / 60).toFixed(1)} min`);
    check('standing at the base gets you picked up', baseNear([line], line.towers[0].x + 3, line.towers[0].z + 3) === line);
    check('standing in the middle of the hill does not', baseNear([line], line.towers[0].x + 60, line.towers[0].z) === null);
    // where you are put down has to be ground you can ride away from, and downhill of the station
    const terrain = { heightAt: (x, z) => heightAt(map, x, z) };
    const spot = unloadSpot(line, terrain);
    const here = heightAt(map, spot.x, spot.z);
    const on = heightAt(map, spot.x + (spot.x - line.towers[line.n].x) * 1.6, spot.z + (spot.z - line.towers[line.n].z) * 1.6);
    check('you are put down below the top station', here < line.towers[line.n].ground + 1,
      `${(here - line.towers[line.n].ground).toFixed(1)} m relative to the station`);
    check('and the ground keeps falling away from there', on < here + 1, `${(on - here).toFixed(1)} m over the next 17 m`);
  }
}
console.log(`\n${fail === 0 ? 'ALL LIFT CHECKS PASSED' : `${fail} CHECK(S) FAILED`}\n`);
process.exit(fail ? 1 : 0);
