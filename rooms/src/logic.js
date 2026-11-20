// Live room rules, as pure functions over a plain state object. The Durable
// Object (index.js) owns the sockets and storage; everything here can be
// unit-tested in Node.
//
// A room has a host, who picks each ayah (the app already knows the ranges and
// how to pick), and up to MAX_PLAYERS people. Two styles:
//   'all'   everyone recites each ayah on their own phone and marks themselves
//   'turns' one person recites each ayah (taking turns); everyone else sees it
//           and marks them
//
// Marks are the same as challenges: g (got it), h (with hints), m (missed).

export const LIMITS = {
  MAX_PLAYERS: 30,
  MAX_NAME: 24,
  MAX_LABEL: 60,
  MAX_ROUNDS: 300,
  MAX_RANGES: 20,
  MAX_MESSAGE: 2048,
  VERSE_COUNT: 6236,
  HOST_GRACE_MS: 45_000, // after this long offline, anyone can move the room on
};

export const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/;
const MARKS = new Set(['g', 'h', 'm']);
const SHOW = new Set(['show', 'reveal', 'off']);

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new RoomError(code, message); };

export function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.MAX_NAME);
}

export function validateSettings(s) {
  if (!s || typeof s !== 'object') fail('bad-settings', 'Missing room settings');
  const mode = s.mode || {};
  if (!SHOW.has(mode.arabic) || !SHOW.has(mode.english)) fail('bad-settings', 'Unknown display mode');
  if (!['all', 'turns'].includes(s.style)) fail('bad-settings', 'Unknown room style');
  return {
    label: String(s.label ?? '').slice(0, LIMITS.MAX_LABEL),
    style: s.style,
    mode: { arabic: mode.arabic, english: mode.english, hideInfo: Boolean(mode.hideInfo) },
    ranges: validateRanges(s.ranges ?? []),
  };
}

// The host's ranges, so whoever leads the room picks from the same ayahs.
// Same shape as the app's settings: { type: 'surah', from: [s, a], to: [s, a] }
// or { type: 'juz' | 'page', from: n, to: n }.
function validateRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length > LIMITS.MAX_RANGES) fail('bad-settings', 'Bad ranges');
  const int = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;
  return ranges.map((r) => {
    if (r?.type === 'surah') {
      const ok = [r.from, r.to].every((e) => Array.isArray(e) && e.length === 2 && int(e[0], 114) && int(e[1], 286));
      if (!ok) fail('bad-settings', 'Bad surah range');
      return { type: 'surah', from: [r.from[0], r.from[1]], to: [r.to[0], r.to[1]] };
    }
    const max = { juz: 30, page: 604 }[r?.type];
    if (!max || !int(r.from, max) || !int(r.to, max)) fail('bad-settings', 'Bad range');
    return { type: r.type, from: r.from, to: r.to };
  });
}

function checkIdentity({ playerId, secret }) {
  if (typeof playerId !== 'string' || !ID_PATTERN.test(playerId)) fail('bad-id', 'Bad player id');
  if (typeof secret !== 'string' || !ID_PATTERN.test(secret)) fail('bad-id', 'Bad player key');
}

function uniqueName(state, name, exceptId) {
  const base = cleanName(name) || 'Someone';
  const taken = new Set(state.players.filter((p) => p.id !== exceptId).map((p) => p.name));
  let unique = base;
  for (let n = 2; taken.has(unique); n++) unique = `${base.slice(0, LIMITS.MAX_NAME - 4)} (${n})`;
  return unique;
}

export function createRoom(code, hello, now) {
  if (!CODE_PATTERN.test(code)) fail('bad-code', 'Bad room code');
  checkIdentity(hello);
  const settings = validateSettings(hello.create);
  return {
    v: 1,
    code,
    created: now,
    touched: now,
    hostId: hello.playerId,
    hostOfflineSince: null,
    settings,
    players: [{ id: hello.playerId, secret: hello.secret, name: cleanName(hello.name) || 'Host', joined: now, left: false }],
    status: 'lobby',
    round: null,
    history: [],
  };
}

// A hello from someone already in the room (same id and key) rejoins them;
// a new id joins as a new player.
export function join(state, hello, now) {
  checkIdentity(hello);
  const existing = state.players.find((p) => p.id === hello.playerId);
  if (existing) {
    if (existing.secret !== hello.secret) fail('bad-id', 'That player id belongs to someone else');
    existing.left = false;
    if (hello.name && cleanName(hello.name) && cleanName(hello.name) !== existing.name) {
      existing.name = uniqueName(state, hello.name, existing.id);
    }
  } else {
    if (state.status === 'ended') fail('ended', 'This room has finished');
    if (state.players.filter((p) => !p.left).length >= LIMITS.MAX_PLAYERS) fail('full', 'This room is full');
    state.players.push({ id: hello.playerId, secret: hello.secret, name: uniqueName(state, hello.name), joined: now, left: false });
  }
  state.touched = now;
}

function canLead(state, playerId, now) {
  if (playerId === state.hostId) return true;
  return state.hostOfflineSince !== null && now - state.hostOfflineSince >= LIMITS.HOST_GRACE_MS;
}

// Next reciter in 'turns' style: the next connected player after the last one,
// in the order people joined.
function nextReciter(state, connected) {
  const people = state.players.filter((p) => !p.left && connected.has(p.id));
  if (!people.length) return null;
  const last = state.round?.reciter ?? state.history.at(-1)?.reciter ?? null;
  const at = state.players.findIndex((p) => p.id === last);
  for (let i = 1; i <= state.players.length; i++) {
    const p = state.players[(at + i + state.players.length) % state.players.length];
    if (people.includes(p)) return p.id;
  }
  return people[0].id;
}

function archiveRound(state) {
  if (!state.round) return;
  const { verseId, reciter, marks } = state.round;
  state.history.push({ verseId, reciter, marks });
  if (state.history.length > LIMITS.MAX_ROUNDS) state.history.splice(0, state.history.length - LIMITS.MAX_ROUNDS);
  state.round = null;
}

// Applies one message from a player. Throws RoomError when it isn't allowed.
export function act(state, playerId, msg, { now, connected }) {
  const me = state.players.find((p) => p.id === playerId && !p.left);
  if (!me) fail('not-joined', 'Join the room first');
  switch (msg?.type) {
    case 'next': {
      if (!canLead(state, playerId, now)) fail('not-host', 'Only the host can move on');
      if (state.status === 'ended') fail('ended', 'This room has finished');
      const verseId = msg.verseId;
      if (!Number.isInteger(verseId) || verseId < 1 || verseId > LIMITS.VERSE_COUNT) fail('bad-verse', 'Bad ayah');
      const n = (state.round?.n ?? state.history.length) + 1;
      const reciter = state.settings.style === 'turns' ? nextReciter(state, connected) : null;
      archiveRound(state);
      state.round = { n, verseId, reciter, marks: {} };
      state.status = 'playing';
      break;
    }
    case 'mark': {
      const round = state.round;
      if (!round) fail('no-round', 'Wait for the next ayah');
      if (!MARKS.has(msg.mark)) fail('bad-mark', 'Bad mark');
      if (state.settings.style === 'all') {
        round.marks[playerId] = msg.mark;
      } else {
        const others = state.players.some((p) => !p.left && p.id !== round.reciter && connected.has(p.id));
        if (playerId === round.reciter && others) fail('own-turn', 'The others mark your turn');
        if (!round.reciter) fail('no-reciter', 'Nobody is reciting');
        round.marks = { [round.reciter]: msg.mark };
      }
      break;
    }
    case 'end': {
      if (!canLead(state, playerId, now)) fail('not-host', 'Only the host can end the room');
      archiveRound(state);
      state.status = 'ended';
      break;
    }
    case 'leave': {
      me.left = true;
      if (state.round?.reciter === playerId && state.settings.style === 'turns') {
        // Hand the turn on rather than leave everyone waiting.
        state.round.reciter = nextReciter(state, new Set([...connected].filter((id) => id !== playerId)));
        state.round.marks = {};
      }
      break;
    }
    case 'rename': {
      const name = cleanName(msg.name);
      if (!name) fail('bad-name', 'Enter a name');
      me.name = uniqueName(state, name, me.id);
      break;
    }
    default:
      fail('bad-message', 'Unknown message');
  }
  state.touched = now;
}

// Called whenever the set of connected sockets changes.
export function updatePresence(state, connected, now) {
  if (connected.has(state.hostId)) state.hostOfflineSince = null;
  else if (state.hostOfflineSince === null) state.hostOfflineSince = now;
}

// What a player sees: everything except the players' keys.
export function snapshot(state, playerId, connected, now) {
  return {
    type: 'state',
    code: state.code,
    you: playerId,
    hostId: state.hostId,
    canLead: canLead(state, playerId, now),
    hostAway: state.hostOfflineSince !== null,
    settings: state.settings,
    status: state.status,
    players: state.players.filter((p) => !p.left).map((p) => ({ id: p.id, name: p.name, online: connected.has(p.id) })),
    round: state.round,
    history: state.history,
  };
}
