// Integration test against a running rooms Worker:
//   npm run dev                         (then, in another terminal)
//   npm run test:live                   local
//   ROOMS=wss://<worker host> ORIGIN=https://hasbuk-web.vercel.app npm run test:live
import assert from 'node:assert/strict';
const BASE = process.env.ROOMS || 'ws://127.0.0.1:8787';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8765';
const HTTP = BASE.replace(/^ws/, 'http');
const rnd = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
const code = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');

function client(roomCode, { origin = ORIGIN } = {}) {
  const ws = new WebSocket(`${BASE}/rooms/${roomCode}`, { headers: { Origin: origin } });
  const c = { ws, states: [], errors: [], closed: null, id: rnd(), secret: rnd() };
  const waiters = [];
  const check = () => { for (const w of [...waiters]) if (w.test()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); (m.type === 'state' ? c.states : c.errors).push(m); check(); };
  ws.onclose = (e) => { c.closed = e.code; check(); };
  c.open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.until = (test, ms = 5000) => new Promise((resolve, reject) => {
    if (test()) return resolve();
    const t = setTimeout(() => reject(new Error('timed out waiting')), ms);
    waiters.push({ test, resolve: () => { clearTimeout(t); resolve(); } });
  });
  c.last = () => c.states.at(-1);
  c.hello = (name, create) => c.send({ type: 'hello', playerId: c.id, secret: c.secret, name, create });
  return c;
}

const settings = { label: 'Juz 30', style: 'turns', mode: { arabic: 'reveal', english: 'off', hideInfo: false } };

// Health and routing
assert.equal(await (await fetch(`${HTTP}/health`)).text(), 'ok');
assert.equal((await fetch(`${HTTP}/rooms/abc`)).status, 404);
assert.equal((await fetch(`${HTTP}/rooms/K7QPM`)).status, 426);
const evil = new WebSocket(`${BASE}/rooms/K7QPM`, { headers: { Origin: 'https://evil.example' } });
assert.equal(await new Promise((res) => { evil.onopen = () => res('opened'); evil.onerror = () => res('refused'); }), 'refused');

const C = code();
// Joining a room that doesn't exist
const ghost = client(C); await ghost.open; ghost.hello('Ghost');
await ghost.until(() => ghost.closed);
assert.equal(ghost.errors[0].code, 'not-found');

// Host creates, two join
const host = client(C); await host.open; host.hello('Host', settings);
await host.until(() => host.last()?.players.length === 1);
assert.equal(host.last().canLead, true);
const a = client(C); await a.open; a.hello('Aisha');
const b = client(C); await b.open; b.hello('Yusuf');
await host.until(() => host.last()?.players.length === 3 && host.last().players.every((p) => p.online));
// Someone else trying to create the same code is refused
const clash = client(C); await clash.open; clash.hello('X', settings);
await clash.until(() => clash.closed);
assert.equal(clash.errors[0].code, 'code-taken');

// Turns: host recites first, Aisha marks
host.send({ type: 'next', verseId: 5673 });
await a.until(() => a.last()?.round?.verseId === 5673);
assert.equal(a.last().round.reciter, host.id);
a.send({ type: 'mark', mark: 'g' });
await b.until(() => b.last()?.round?.marks?.[host.id] === 'g');
// Non-host can't move on
a.send({ type: 'next', verseId: 1 });
await a.until(() => a.errors.some((e) => e.code === 'not-host'));
host.send({ type: 'next', verseId: 5674 });
await b.until(() => b.last()?.round?.n === 2);
assert.equal(b.last().round.reciter, a.id);
assert.equal(b.last().history.length, 1);

// Aisha drops and reconnects with the same id: same player, state intact
a.ws.close();
await host.until(() => host.last()?.players.find((p) => p.id === a.id)?.online === false);
const a2 = client(C); a2.id = a.id; a2.secret = a.secret; await a2.open; a2.hello('Aisha');
await a2.until(() => a2.last()?.round?.n === 2);
assert.equal(a2.last().players.length, 3);
// Impersonation with the wrong key is refused
const fake = client(C); fake.id = a.id; await fake.open; fake.hello('Aisha');
await fake.until(() => fake.closed);
assert.equal(fake.errors[0].code, 'bad-id');

// Opening a second connection for the same player replaces the first
const a3 = client(C); a3.id = a.id; a3.secret = a.secret; await a3.open; a3.hello('Aisha');
await a2.until(() => a2.closed === 4000);
await a3.until(() => a3.last()?.round?.n === 2);

// Ping keeps the connection alive without waking the room
const pong = new Promise((res) => { const old = a3.ws.onmessage; a3.ws.onmessage = (e) => { if (e.data === 'pong') res(); else old(e); }; });
a3.ws.send('ping'); await pong;

// Ending
host.send({ type: 'end' });
await b.until(() => b.last()?.status === 'ended');
assert.equal(b.last().history.length, 2);
const late = client(C); await late.open; late.hello('Late');
await late.until(() => late.closed);
assert.equal(late.errors[0].code, 'ended');

for (const c of [host, a3, b]) c.ws.close();
console.log('rooms integration passed against', BASE);
process.exit(0);
