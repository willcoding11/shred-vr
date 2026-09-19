// Tiny auto-reconnecting WebSocket client used by the game and the editor.
export class LiveClient {
  constructor(role) {
    this.role = role;
    this.handlers = {};
    this.connected = false;
    this.queue = [];
    this.backoff = 500;
    this.connect();
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true; this.backoff = 500;
      ws.send(JSON.stringify({ type: 'hello', role: this.role }));
      for (const m of this.queue.splice(0)) ws.send(m);
      this.emit('open', {});
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      this.emit(msg.type, msg);
    };
    ws.onclose = () => {
      this.connected = false; this.emit('close', {});
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(5000, this.backoff * 1.6);
    };
    ws.onerror = () => ws.close();
  }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  emit(type, msg) { for (const fn of this.handlers[type] || []) fn(msg); }
  send(obj) {
    const s = JSON.stringify(obj);
    if (this.connected && this.ws.readyState === 1) { this.ws.send(s); return; }
    if (obj.type === 'map' || obj.type === 'active') { this.queue.push(s); return; }
    // patch/props/env are only meaningful in order, so they are dropped rather than queued --
    // the sender is told, and resends the whole map once the socket is back.
    this.dropped = true;
  }
}
