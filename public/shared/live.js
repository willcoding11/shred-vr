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
      if (this.closing) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(5000, this.backoff * 1.6);
    };
    ws.onerror = () => ws.close();
    // Hang up when the page goes away. A browser does not reliably close a WebSocket on
    // navigation -- it can sit half-open until the server's ping reaper notices -- and the editor
    // counts those as live headsets. Six of them had accumulated on a server left running
    // overnight. `closing` stops onclose from starting the reconnect timer on the way out.
    if (!this._bye) {
      this._bye = () => { this.closing = true; try { this.ws?.close(); } catch {} };
      addEventListener('pagehide', this._bye);
      addEventListener('beforeunload', this._bye);
      // pagehide also fires when a page goes into the back/forward cache, and that page can come
      // back. Without this it would come back with `closing` still set and never reconnect --
      // live sync would be silently dead until you reloaded by hand.
      addEventListener('pageshow', () => { if (this.closing) { this.closing = false; this.connect(); } });
    }
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
