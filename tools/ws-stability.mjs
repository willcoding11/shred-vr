// Verifies a live client survives the server heartbeat. Run: node tools/ws-stability.mjs [seconds]
import WebSocket from 'ws';
const secs = Number(process.argv[2] || 40);
const ws = new WebSocket('ws://localhost:8080/ws');
const t0 = Date.now();
let pings = 0, closed = null;
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'game' })));
ws.on('ping', () => { pings++; console.log(`  server ping #${pings} at ${((Date.now() - t0) / 1000).toFixed(1)}s`); });
ws.on('close', (c) => { closed = { c, at: ((Date.now() - t0) / 1000).toFixed(1) }; });
setTimeout(() => {
  if (closed) { console.log(`FAIL: socket closed (code ${closed.c}) after ${closed.at}s`); process.exit(1); }
  console.log(`OK: socket alive for ${secs}s across ${pings} server heartbeat(s)`);
  ws.close(); process.exit(0);
}, secs * 1000);
