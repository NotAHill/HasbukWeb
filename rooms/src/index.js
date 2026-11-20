// Hasbuk live rooms: a Cloudflare Worker that routes each room code to its own
// Durable Object, which holds the room's WebSockets and state.
//
//   GET /health                 -> "ok"
//   GET /rooms/<CODE> (Upgrade) -> WebSocket for that room
//
// Protocol (JSON text frames; "ping" gets "pong" without waking the room):
//   client -> { type: 'hello', playerId, secret, name, create?: settings }
//             { type: 'next', verseId } | { type: 'mark', mark } | { type: 'end' }
//             { type: 'leave' } | { type: 'rename', name }
//   server -> { type: 'state', ... } after every change (see snapshot() in logic.js)
//             { type: 'error', code, message }
//
// Rooms delete themselves after ROOM_TTL_MS without activity.

import { DurableObject } from 'cloudflare:workers';
import { LIMITS, CODE_PATTERN, RoomError, createRoom, join, act, updatePresence, snapshot } from './logic.js';

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
// Errors on hello that mean this socket can't be in the room.
const FATAL_ON_HELLO = new Set(['not-found', 'code-taken', 'bad-id', 'full', 'ended', 'bad-settings', 'bad-code']);

function originAllowed(origin, env) {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  const exact = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (exact.includes(origin)) return true;
  return Boolean(env.ALLOWED_ORIGIN_PATTERN) && new RegExp(env.ALLOWED_ORIGIN_PATTERN).test(origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const match = /^\/rooms\/([^/]+)$/.exec(url.pathname);
    if (!match || !CODE_PATTERN.test(match[1])) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!originAllowed(request.headers.get('Origin'), env)) return new Response('Forbidden', { status: 403 });
    const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    return room.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) ?? null;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const code = new URL(request.url).pathname.split('/').pop();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ code, playerId: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  connected(except) {
    const ids = new Set();
    for (const ws of this.sockets(except)) {
      const id = ws.deserializeAttachment()?.playerId;
      if (id) ids.add(id);
    }
    return ids;
  }

  async webSocketMessage(ws, raw) {
    const attachment = ws.deserializeAttachment() || {};
    const send = (data) => { try { ws.send(JSON.stringify(data)); } catch { /* socket gone */ } };
    let msg;
    try {
      if (typeof raw !== 'string' || raw.length > LIMITS.MAX_MESSAGE) throw new RoomError('bad-message', 'Message too large');
      try {
        msg = JSON.parse(raw);
      } catch {
        throw new RoomError('bad-message', 'Not JSON');
      }
      const now = Date.now();
      if (msg?.type === 'hello') {
        if (attachment.playerId) throw new RoomError('bad-message', 'Already joined');
        if (!this.state) {
          if (!msg.create) throw new RoomError('not-found', 'There\'s no room with that code. It may have finished.');
          this.state = createRoom(attachment.code, msg, now);
        } else if (msg.create && msg.playerId !== this.state.hostId) {
          throw new RoomError('code-taken', 'That room code is in use');
        } else {
          join(this.state, msg, now);
        }
        // One connection per player: a new one replaces an old one.
        for (const other of this.sockets(ws)) {
          if (other.deserializeAttachment()?.playerId === msg.playerId) {
            other.serializeAttachment({ code: attachment.code, playerId: null });
            try { other.close(4000, 'replaced'); } catch { /* already closing */ }
          }
        }
        ws.serializeAttachment({ ...attachment, playerId: msg.playerId });
      } else {
        if (!attachment.playerId || !this.state) throw new RoomError('not-joined', 'Join the room first');
        act(this.state, attachment.playerId, msg, { now, connected: this.connected() });
      }
    } catch (err) {
      if (!(err instanceof RoomError)) throw err;
      send({ type: 'error', code: err.code, message: err.message });
      if (msg?.type === 'hello' && FATAL_ON_HELLO.has(err.code)) {
        try { ws.close(4001, err.code); } catch { /* already closing */ }
      }
      return;
    }
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws) {
    await this.onDisconnect(ws);
  }

  async webSocketError(ws) {
    await this.onDisconnect(ws);
  }

  async onDisconnect(ws) {
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    if (!this.state || !ws.deserializeAttachment()?.playerId) return;
    await this.save(ws);
    this.broadcast(ws);
  }

  broadcast(except) {
    if (!this.state) return;
    const now = Date.now();
    const connected = this.connected(except);
    for (const ws of this.sockets(except)) {
      const id = ws.deserializeAttachment()?.playerId;
      if (!id) continue;
      try { ws.send(JSON.stringify(snapshot(this.state, id, connected, now))); } catch { /* socket gone */ }
    }
  }

  async save(except) {
    updatePresence(this.state, this.connected(except), Date.now());
    await this.ctx.storage.put('state', this.state);
    await this.ctx.storage.setAlarm(this.state.touched + ROOM_TTL_MS);
  }

  async alarm() {
    if (this.state && Date.now() - this.state.touched < ROOM_TTL_MS) {
      await this.ctx.storage.setAlarm(this.state.touched + ROOM_TTL_MS);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4002, 'expired'); } catch { /* already closed */ }
    }
    this.state = null;
    await this.ctx.storage.deleteAll();
  }
}
