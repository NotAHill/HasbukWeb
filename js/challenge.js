// Challenge links: a fixed set of ayahs that friends play in their own time.
//
// There's no server. Everything lives in the link's #fragment (which browsers
// never send to a server): the ayahs, how to show them, and the results of
// everyone who has played so far. Each player who finishes shares a new link
// with their own result added, so the scoreboard travels with the link.
//
// Scores are self-graded, like the rest of Hasbuk: it's for friends, not exams.

import { VERSE_COUNT } from './data.js';
import { pickRandom } from './picker.js';

export const SIZES = [5, 10, 20];
export const MAX_QUESTIONS = 30;
export const MAX_PLAYERS = 30;
export const MAX_NAME = 24;
export const MAX_LABEL = 60;
const HASH_KEY = 'c';
const FORMAT = 1;

// Per-question marks: got it, got it with hints, missed.
export const MARKS = { got: 'g', hinted: 'h', missed: 'm' };

// How the ayahs are shown; copied from the creator's settings so everyone
// plays the same way.
const SHOW = { show: 's', reveal: 'r', off: 'o' };
const SHOW_BACK = Object.fromEntries(Object.entries(SHOW).map(([k, v]) => [v, k]));

export class BadChallenge extends Error {}

export function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function randomId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b & 31]).join('');
}

// Picks `count` different ayahs from the ranges (fewer if the ranges are smaller).
export function pickQuestions(quran, ranges, count, { rng } = {}) {
  const ids = [];
  const exclude = new Set();
  for (let i = 0; i < count; i++) {
    const { id, exhausted } = pickRandom(quran, ranges, { exclude, rng });
    if (exhausted) break;
    ids.push(id);
    exclude.add(id);
  }
  return ids;
}

export function createChallenge({ ids, by, label, mode }) {
  return {
    id: randomId(),
    by: cleanName(by),
    label: String(label ?? '').slice(0, MAX_LABEL),
    ids: [...ids],
    mode: { arabic: mode.arabic, english: mode.english, hideInfo: Boolean(mode.hideInfo) },
    results: [],
  };
}

// --------------------------------------------------------------- scoring

export function tally(marks) {
  const t = { got: 0, hinted: 0, missed: 0 };
  for (const m of marks) {
    if (m === MARKS.got) t.got++;
    else if (m === MARKS.hinted) t.hinted++;
    else t.missed++;
  }
  return t;
}

// A clean "got it" is a point; with hints, half a point.
export function score(marks) {
  const t = tally(marks);
  return t.got + t.hinted / 2;
}

export function formatScore(marks) {
  const s = score(marks);
  const whole = Math.floor(s);
  const half = s - whole ? '½' : '';
  return `${whole || !half ? whole : ''}${half}/${marks.length}`;
}

// Best first; ties keep the order people played in.
export function ranked(results) {
  return results
    .map((r, order) => ({ ...r, order, score: score(r.marks) }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
}

// Adds a finished result, renaming it "Name (2)" if the name is taken.
export function addResult(challenge, name, marks) {
  const base = cleanName(name) || 'Someone';
  const taken = new Set(challenge.results.map((r) => r.name));
  let unique = base;
  for (let n = 2; taken.has(unique); n++) unique = `${base.slice(0, MAX_NAME - 4)} (${n})`;
  const result = { name: unique, marks };
  challenge.results = [...challenge.results, result].slice(-MAX_PLAYERS);
  return result;
}

// Two links for the same challenge: keep everyone from both, without
// duplicating the people in both.
export function mergeResults(a, b) {
  const seen = new Set(a.map((r) => `${r.name}\u0000${r.marks}`));
  const out = [...a];
  for (const r of b) {
    const key = `${r.name}\u0000${r.marks}`;
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out.slice(-MAX_PLAYERS);
}

// --------------------------------------------------------------- links

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeChallenge(c) {
  const mode = SHOW[c.mode.arabic] + SHOW[c.mode.english] + (c.mode.hideInfo ? '1' : '0');
  const payload = [FORMAT, c.id, c.by, c.label, mode, c.ids, c.results.map((r) => [r.name, r.marks])];
  return toBase64Url(JSON.stringify(payload));
}

export function decodeChallenge(text) {
  let p;
  try {
    p = JSON.parse(fromBase64Url(text));
  } catch {
    throw new BadChallenge('not a challenge');
  }
  const fail = (why) => { throw new BadChallenge(why); };
  if (!Array.isArray(p) || p[0] !== FORMAT) fail('unknown format');
  const [, id, by, label, mode, ids, results] = p;
  if (typeof id !== 'string' || !/^[a-z0-9]{4,16}$/.test(id)) fail('bad id');
  if (typeof by !== 'string' || typeof label !== 'string') fail('bad text');
  if (typeof mode !== 'string' || !/^[sro][sro][01]$/.test(mode)) fail('bad mode');
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_QUESTIONS) fail('bad question count');
  if (!ids.every((n) => Number.isInteger(n) && n >= 1 && n <= VERSE_COUNT)) fail('bad ayah');
  if (new Set(ids).size !== ids.length) fail('repeated ayah');
  if (!Array.isArray(results) || results.length > MAX_PLAYERS) fail('bad results');
  const markPattern = new RegExp(`^[ghm]{${ids.length}}$`);
  const clean = results.map((r) => {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string' || !markPattern.test(r[1])) fail('bad result');
    return { name: cleanName(r[0]) || 'Someone', marks: r[1] };
  });
  return {
    id,
    by: cleanName(by),
    label: label.slice(0, MAX_LABEL),
    ids,
    mode: { arabic: SHOW_BACK[mode[0]], english: SHOW_BACK[mode[1]], hideInfo: mode[2] === '1' },
    results: clean,
  };
}

export function challengeUrl(c, base) {
  const url = new URL(base);
  url.search = '';
  url.hash = `${HASH_KEY}=${encodeChallenge(c)}`;
  return url.href;
}

// The encoded challenge in a location hash ("#c=..."), or null.
export function challengeFromHash(hash) {
  const m = /^#?c=([A-Za-z0-9_-]+)$/.exec(hash || '');
  return m ? m[1] : null;
}

export function describeMode(mode) {
  const parts = [];
  if (mode.arabic === 'reveal') parts.push('Arabic hidden until tapped');
  else if (mode.arabic === 'off') parts.push('no Arabic');
  if (mode.english === 'reveal') parts.push('translation hidden until tapped');
  else if (mode.english === 'off') parts.push('no translation');
  if (mode.hideInfo) parts.push('surah and ayah hidden');
  return parts.length ? parts.join(', ') : 'everything shown';
}
