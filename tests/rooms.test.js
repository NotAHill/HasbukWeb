import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, join, act, snapshot, updatePresence, RoomError, LIMITS } from '../rooms/src/logic.js';

const settings = (style = 'all') => ({ label: 'Juz 30', style, mode: { arabic: 'reveal', english: 'off', hideInfo: true } });
const who = (n) => ({ playerId: `player-${n}-xxxx`, secret: `secret-${n}-xxxx`, name: `P${n}` });
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof RoomError && e.code === code, code);

function room(style) {
  const state = createRoom('K7QPM', { ...who(1), name: 'Host', create: settings(style) }, 0);
  join(state, who(2), 1);
  join(state, who(3), 2);
  return state;
}
const all = (state) => new Set(state.players.map((p) => p.id));

test('rooms: creating, joining, rejoining and identity', () => {
  const state = room('all');
  assert.equal(state.hostId, who(1).playerId);
  assert.deepEqual(state.players.map((p) => p.name), ['Host', 'P2', 'P3']);
  // Same id + key rejoins (and can rename); same id with another key is refused
  join(state, { ...who(2), name: 'Yusuf' }, 3);
  assert.equal(state.players.length, 3);
  assert.equal(state.players[1].name, 'Yusuf');
  throwsCode(() => join(state, { ...who(2), secret: 'someone-else-key' }, 4), 'bad-id');
  // Taken names get a number
  join(state, { ...who(4), name: 'Yusuf' }, 5);
  assert.equal(state.players[3].name, 'Yusuf (2)');
  // Bad input
  throwsCode(() => createRoom('k7qpm', { ...who(1), create: settings() }, 0), 'bad-code');
  throwsCode(() => createRoom('K7QPM', { ...who(1), create: { ...settings(), style: 'race' } }, 0), 'bad-settings');
  throwsCode(() => join(state, { playerId: 'x', secret: 'y' }, 0), 'bad-id');
  // Ranges pass through cleaned; bad ones are refused
  const ranged = createRoom('K7QPM', { ...who(1), create: { ...settings(), ranges: [{ type: 'juz', from: 30, to: 30, extra: 1 }, { type: 'surah', from: [2, 1], to: [2, 286] }] } }, 0);
  assert.deepEqual(ranged.settings.ranges, [{ type: 'juz', from: 30, to: 30 }, { type: 'surah', from: [2, 1], to: [2, 286] }]);
  for (const bad of [[{ type: 'juz', from: 31, to: 1 }], [{ type: 'surah', from: [2], to: [2, 1] }], [{ type: 'hizb', from: 1, to: 1 }], 'x'])
    throwsCode(() => createRoom('K7QPM', { ...who(1), create: { ...settings(), ranges: bad } }, 0), 'bad-settings');
  // Keys never leave the server
  const snap = snapshot(state, who(2).playerId, all(state), 10);
  assert.ok(!JSON.stringify(snap).includes('secret-'));
  assert.equal(snap.canLead, false);
  assert.equal(snapshot(state, who(1).playerId, all(state), 10).canLead, true);
});

test('rooms: full rooms and finished rooms refuse newcomers', () => {
  const state = room('all');
  for (let i = 4; i <= LIMITS.MAX_PLAYERS; i++) join(state, who(i), i);
  throwsCode(() => join(state, who(99), 99), 'full');
  join(state, who(5), 100); // existing players can still come back
  act(state, who(1).playerId, { type: 'end' }, { now: 101, connected: all(state) });
  throwsCode(() => join(state, who(98), 102), 'ended');
});

test("rooms: 'all' style — host moves on, everyone marks themselves", () => {
  const state = room('all');
  const ctx = { now: 10, connected: all(state) };
  throwsCode(() => act(state, who(2).playerId, { type: 'next', verseId: 5 }, ctx), 'not-host');
  throwsCode(() => act(state, who(2).playerId, { type: 'mark', mark: 'g' }, ctx), 'no-round');
  throwsCode(() => act(state, who(1).playerId, { type: 'next', verseId: 7000 }, ctx), 'bad-verse');
  act(state, who(1).playerId, { type: 'next', verseId: 5673 }, ctx);
  assert.deepEqual(state.round, { n: 1, verseId: 5673, reciter: null, marks: {} });
  act(state, who(2).playerId, { type: 'mark', mark: 'h' }, ctx);
  act(state, who(3).playerId, { type: 'mark', mark: 'g' }, ctx);
  act(state, who(3).playerId, { type: 'mark', mark: 'm' }, ctx); // can change their mind
  throwsCode(() => act(state, who(3).playerId, { type: 'mark', mark: 'x' }, ctx), 'bad-mark');
  act(state, who(1).playerId, { type: 'next', verseId: 5674 }, ctx);
  assert.deepEqual(state.history, [{ verseId: 5673, reciter: null, marks: { [who(2).playerId]: 'h', [who(3).playerId]: 'm' } }]);
  assert.equal(state.round.n, 2);
  throwsCode(() => act(state, who(2).playerId, { type: 'teleport' }, ctx), 'bad-message');
});

test("rooms: 'turns' style — reciters rotate, others mark them", () => {
  const state = room('turns');
  const ids = state.players.map((p) => p.id);
  const ctx = { now: 10, connected: new Set(ids) };
  const next = (verseId) => act(state, ids[0], { type: 'next', verseId }, ctx);
  next(1);
  assert.equal(state.round.reciter, ids[0]);
  throwsCode(() => act(state, ids[0], { type: 'mark', mark: 'g' }, ctx), 'own-turn');
  act(state, ids[1], { type: 'mark', mark: 'h' }, ctx);
  act(state, ids[2], { type: 'mark', mark: 'g' }, ctx); // a later judge overrides
  assert.deepEqual(state.round.marks, { [ids[0]]: 'g' });
  next(2);
  assert.equal(state.round.reciter, ids[1]);
  // Offline players are skipped
  ctx.connected = new Set([ids[0], ids[1]]);
  next(3);
  assert.equal(state.round.reciter, ids[0]);
  // The reciter leaving hands the turn on
  act(state, ids[0], { type: 'leave' }, ctx);
  assert.equal(state.round.reciter, ids[1]);
  // Alone in the room, you can mark yourself
  ctx.connected = new Set([ids[1]]);
  act(state, ids[1], { type: 'mark', mark: 'g' }, ctx);
  assert.deepEqual(state.round.marks, { [ids[1]]: 'g' });
});

test('rooms: if the host is away long enough, anyone can move on', () => {
  const state = room('all');
  const others = new Set([who(2).playerId, who(3).playerId]);
  updatePresence(state, others, 1000);
  const tooSoon = { now: 1000 + LIMITS.HOST_GRACE_MS - 1, connected: others };
  throwsCode(() => act(state, who(2).playerId, { type: 'next', verseId: 9 }, tooSoon), 'not-host');
  act(state, who(2).playerId, { type: 'next', verseId: 9 }, { now: 1000 + LIMITS.HOST_GRACE_MS, connected: others });
  assert.equal(state.round.verseId, 9);
  updatePresence(state, all(state), 2_000_000); // host is back
  throwsCode(() => act(state, who(2).playerId, { type: 'next', verseId: 10 }, { now: 2_000_000, connected: all(state) }), 'not-host');
});
