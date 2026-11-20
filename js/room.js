// Live rooms: the connection to the room server (rooms/ in this repo, a
// Cloudflare Worker). Keeps one WebSocket open, reconnects after drops (phones
// lock, trains go into tunnels), and reports each new room state.

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
export const ROOMS_URL = LOCAL ? `ws://${location.hostname}:8787` : 'wss://hasbuk-rooms.hasbuk-rooms.workers.dev';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];
const PING_MS = 25_000;

// Errors after which reconnecting won't help.
export const FATAL = new Set(['not-found', 'code-taken', 'bad-id', 'full', 'ended', 'bad-settings', 'bad-code', 'replaced', 'expired']);

function random(alphabet, length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const newCode = () => random(CODE_ALPHABET, 5);
export const newId = () => random('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 22);

// Tidies what people type: "k7q pm" -> "K7QPM". Codes never use 0, O, 1, I or L.
export function normaliseCode(text) {
  return String(text || '').toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '').slice(0, 5);
}

export class RoomConnection {
  // hello: what to send on every (re)connect; handlers: onState, onError, onStatus('connecting'|'open'|'offline'|'closed')
  constructor(code, hello, handlers) {
    this.code = code;
    this.hello = hello;
    this.handlers = handlers;
    this.attempt = 0;
    this.closed = false;
    this.ws = null;
    this.onOnline = () => this.reconnectSoon(0);
    this.onVisible = () => { if (document.visibilityState === 'visible') this.reconnectSoon(0); };
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  connect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.handlers.onStatus?.('connecting');
    let ws;
    try {
      ws = new WebSocket(`${ROOMS_URL}/rooms/${this.code}`);
    } catch {
      this.reconnectSoon();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', ...this.hello }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, PING_MS);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'state') {
        this.attempt = 0;
        this.handlers.onStatus?.('open');
        this.handlers.onState?.(msg);
      } else if (msg.type === 'error') {
        if (FATAL.has(msg.code)) this.stop();
        this.handlers.onError?.(msg);
      }
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws || this.closed) return;
      if (e.code === 4000) { this.stop(); this.handlers.onError?.({ code: 'replaced', message: 'This room is open on another tab or device.' }); return; }
      if (e.code === 4002) { this.stop(); this.handlers.onError?.({ code: 'expired', message: 'This room has closed.' }); return; }
      this.handlers.onStatus?.('offline');
      this.reconnectSoon();
    };
  }

  reconnectSoon(delay) {
    if (this.closed) return;
    if (delay === 0 && this.ws?.readyState === WebSocket.OPEN) return;
    clearTimeout(this.retryTimer);
    const wait = delay ?? RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
        if (this.ws.readyState === WebSocket.OPEN) return;
        this.ws.onclose = null;
        try { this.ws.close(); } catch { /* ignore */ }
      }
      this.connect();
    }, wait);
  }

  send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  stop() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(1000, 'bye'); } catch { /* ignore */ }
    }
    this.handlers.onStatus?.('closed');
  }
}

// A QR code as an SVG element, black on white (what every scanner reads, even in dark mode).
export function qrSvg(qrcode, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  const size = n + margin * 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code for the room link');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}
