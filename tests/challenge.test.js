import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQuran } from '../js/data.js';
import {
  pickQuestions, createChallenge, encodeChallenge, decodeChallenge, challengeUrl, challengeFromHash,
  addResult, mergeResults, ranked, formatScore, tally, cleanName, describeMode, BadChallenge,
  MAX_NAME, MAX_PLAYERS,
} from '../js/challenge.js';

const quran = createQuran(JSON.parse(readFileSync(new URL('../data/quran.min.json', import.meta.url))));
const mode = { arabic: 'reveal', english: 'off', hideInfo: true };

function sample(extra = {}) {
  return { ...createChallenge({ ids: [5673, 5674, 1], by: 'Aisha', label: 'Juz 30', mode }), ...extra };
}

test('challenge: questions are distinct and inside the ranges', () => {
  const ranges = [{ type: 'juz', from: 30, to: 30 }];
  const [start, end] = quran.juzRange(30);
  const ids = pickQuestions(quran, ranges, 20);
  assert.equal(ids.length, 20);
  assert.equal(new Set(ids).size, 20);
  assert.ok(ids.every((id) => id >= start && id <= end));
  // A range smaller than the request gives every ayah once.
  const small = pickQuestions(quran, [{ type: 'surah', from: [112, 1], to: [112, 4] }], 10);
  assert.deepEqual([...small].sort((a, b) => a - b), [6222, 6223, 6224, 6225]);
});

test('challenge: links round-trip, including Arabic names', () => {
  const c = sample();
  addResult(c, 'عائشة', 'ghm');
  addResult(c, 'Yusuf', 'ggg');
  const back = decodeChallenge(encodeChallenge(c));
  assert.deepEqual(back, c);
  const url = challengeUrl(c, 'https://hasbuk.example/app/?utm=x#old');
  assert.match(url, /^https:\/\/hasbuk\.example\/app\/#c=[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeChallenge(challengeFromHash(new URL(url).hash)), c);
  assert.equal(challengeFromHash('#something-else'), null);
  assert.equal(challengeFromHash(''), null);
});

test('challenge: broken or tampered links are rejected', () => {
  const enc = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');
  const good = [1, 'abcdef', 'A', 'Juz 30', 'rs0', [1, 2], [['B', 'gm']]];
  assert.doesNotThrow(() => decodeChallenge(enc(good)));
  const bad = [
    'not base64 at all!',
    enc({ hello: 1 }),
    enc([2, ...good.slice(1)]), // unknown format version
    enc(good.map((v, i) => (i === 4 ? 'xx1' : v))), // mode
    enc(good.map((v, i) => (i === 5 ? [1, 99999] : v))), // ayah out of range
    enc(good.map((v, i) => (i === 5 ? [3, 3] : v))), // repeated ayah
    enc(good.map((v, i) => (i === 5 ? [] : v))), // no questions
    enc(good.map((v, i) => (i === 6 ? [['B', 'g']] : v))), // marks don't match questions
    enc(good.map((v, i) => (i === 6 ? [['B', 'gx']] : v))), // unknown mark
  ];
  for (const text of bad) assert.throws(() => decodeChallenge(text), BadChallenge, text);
});

test('challenge: names are cleaned and made unique', () => {
  assert.equal(cleanName('  Big \n  Sis  '), 'Big Sis');
  assert.equal(cleanName('x'.repeat(50)).length, MAX_NAME);
  const c = sample();
  assert.equal(addResult(c, 'Ali', 'ggg').name, 'Ali');
  assert.equal(addResult(c, 'Ali', 'mmm').name, 'Ali (2)');
  assert.equal(addResult(c, 'Ali', 'hhh').name, 'Ali (3)');
  assert.equal(addResult(c, '   ', 'hhh').name, 'Someone');
});

test('challenge: scoring, ranking and merging', () => {
  assert.deepEqual(tally('gghm'), { got: 2, hinted: 1, missed: 1 });
  assert.equal(formatScore('gghm'), '2½/4');
  assert.equal(formatScore('hmmm'), '½/4');
  assert.equal(formatScore('mmmm'), '0/4');
  assert.equal(formatScore('gggg'), '4/4');
  const order = ranked([
    { name: 'A', marks: 'ghm' }, // 1.5
    { name: 'B', marks: 'ggm' }, // 2
    { name: 'C', marks: 'hhh' }, // 1.5, played after A
  ]).map((r) => r.name);
  assert.deepEqual(order, ['B', 'A', 'C']);

  const a = [{ name: 'A', marks: 'g' }, { name: 'B', marks: 'm' }];
  const b = [{ name: 'A', marks: 'g' }, { name: 'C', marks: 'h' }];
  assert.deepEqual(mergeResults(a, b).map((r) => r.name), ['A', 'B', 'C']);

  const many = sample();
  for (let i = 0; i < MAX_PLAYERS + 5; i++) addResult(many, `P${i}`, 'ggg');
  assert.equal(many.results.length, MAX_PLAYERS);
  assert.equal(many.results.at(-1).name, `P${MAX_PLAYERS + 4}`);
});

test('challenge: mode description', () => {
  assert.equal(describeMode(mode), 'Arabic hidden until tapped, no translation, surah and ayah hidden');
  assert.equal(describeMode({ arabic: 'show', english: 'show', hideInfo: false }), 'everything shown');
});
