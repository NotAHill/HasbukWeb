import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQuran, VERSE_COUNT } from '../js/data.js';
import { formatEnglish, formatArabic, splitWords, BRACKETS } from '../js/text.js';
import { rangeToIds, mergeIntervals, pickRandom, rangeLabel, countVerses } from '../js/picker.js';

const raw = JSON.parse(readFileSync(new URL('../data/quran.min.json', import.meta.url)));
const quran = createQuran(raw);

// Deterministic RNG (mulberry32) for repeatable picks.
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('data: counts and well-known locations', () => {
  assert.equal(raw.ar.length, VERSE_COUNT);
  assert.equal(quran.surahs.length, 114);
  assert.deepEqual(
    (({ surah, ayah, juz, page }) => ({ surah, ayah, juz, page }))(quran.verse(quran.idFor(2, 255))),
    { surah: 2, ayah: 255, juz: 3, page: 42 },
  );
  assert.equal(quran.verse(quran.idFor(5, 82)).juz, 7);
  assert.equal(quran.verse(quran.idFor(78, 1)).page, 582);
  assert.equal(quran.verse(quran.idFor(5, 77)).page, 121); // 1405 layout (newer prints: 120)
  assert.deepEqual(quran.pageRange(604), [quran.idFor(112, 1), VERSE_COUNT]);
  assert.deepEqual(quran.juzRange(1), [1, quran.idFor(2, 141)]);
  const last = quran.verse(VERSE_COUNT);
  assert.equal(last.surah, 114); assert.equal(last.ayah, 6); assert.equal(last.juz, 30);
});

test('data: 2:72 thin-space fix is applied and no stray spaces remain', () => {
  const text = quran.verse(quran.idFor(2, 72)).arabic;
  assert.ok(!text.includes(' '));
  assert.ok(text.includes('\u0631\u064E\u0670\u0654\u062A'), 'ra + fatha + dagger alef + hamza, then ta');
  assert.ok(raw.ar.every(t => !/[ -​]/.test(t)));
});

test('text: bracket modes', () => {
  const t = '[All] praise is [due] to Allah, Lord of the worlds';
  assert.equal(formatEnglish(t, BRACKETS.KEEP), t);
  assert.equal(formatEnglish(t, BRACKETS.MARKS), 'All praise is due to Allah, Lord of the worlds');
  assert.equal(formatEnglish(t, BRACKETS.WORDS), 'praise is to Allah, Lord of the worlds');
  // 2:4 used to leave "to you, , and"
  const v24 = quran.verse(quran.idFor(2, 4)).english;
  const words = formatEnglish(v24, BRACKETS.WORDS);
  assert.ok(!/ [,.;:]/.test(words), words);
  assert.ok(!/[,;:]\s*[,;:]/.test(words), words);
});

test('text: no verse is left with orphaned punctuation in words mode', () => {
  for (const en of raw.en) {
    const out = formatEnglish(en, BRACKETS.WORDS);
    assert.ok(!/\s[,.;:!?]/.test(out), out);
    assert.ok(!/^[,;:]/.test(out), out);
  }
});

test('text: hizb marker hidden unless asked for', () => {
  const id = raw.ar.findIndex(t => t.includes('۞')) + 1;
  const ar = quran.verse(id).arabic;
  assert.ok(!formatArabic(ar).includes('۞'));
  assert.ok(formatArabic(ar, { showHizbMarker: true }).includes('۞'));
  assert.ok(!formatArabic(ar).startsWith(' '));
  assert.ok(splitWords(formatArabic(ar)).length > 1);
});

test('ranges: conversion, normalisation and labels', () => {
  assert.deepEqual(rangeToIds(quran, { type: 'juz', from: 30, to: 30 }), { start: quran.idFor(78, 1), end: VERSE_COUNT });
  // Reversed ends are swapped rather than rejected
  assert.deepEqual(
    rangeToIds(quran, { type: 'surah', from: [3, 10], to: [2, 5] }),
    { start: quran.idFor(2, 5), end: quran.idFor(3, 10) },
  );
  assert.deepEqual(mergeIntervals([{ start: 10, end: 20 }, { start: 1, end: 5 }, { start: 6, end: 12 }]), [{ start: 1, end: 20 }]);
  assert.equal(rangeLabel(quran, { type: 'surah', from: [67, 1], to: [67, 30] }), 'Al-Mulk');
  assert.equal(rangeLabel(quran, { type: 'surah', from: [2, 1], to: [2, 100] }), 'Al-Baqarah 1–100');
  assert.equal(rangeLabel(quran, { type: 'juz', from: 29, to: 30 }), 'Juz 29–30');
  assert.equal(countVerses(quran, []), VERSE_COUNT);
  assert.equal(countVerses(quran, [{ type: 'surah', from: [1, 1], to: [1, 7] }, { type: 'surah', from: [1, 3], to: [1, 7] }]), 7);
});

test('picker: stays inside ranges', () => {
  const rng = seeded(1);
  const ranges = [{ type: 'surah', from: [2, 50], to: [2, 60] }, { type: 'juz', from: 30, to: 30 }];
  const a = quran.idFor(2, 50); const b = quran.idFor(2, 60); const j = quran.juzRange(30);
  for (let i = 0; i < 2000; i++) {
    const { id } = pickRandom(quran, ranges, { rng });
    assert.ok((id >= a && id <= b) || (id >= j[0] && id <= j[1]), `out of range: ${id}`);
  }
});

test('picker: a lone ayah on a page is not over-weighted', () => {
  // 2:5 is the last ayah of page 2; 2:6.. starts page 3 (2:6–2:16).
  const ranges = [{ type: 'surah', from: [2, 5], to: [2, 16] }];
  const rng = seeded(7);
  let lone = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) if (pickRandom(quran, ranges, { rng }).id === quran.idFor(2, 5)) lone++;
  // Page 2 has 5 ayahs, 1 in range -> weight 0.2 vs page 3 weight 1.0 => ~1/6.
  // The old algorithm gave it 1/2.
  assert.ok(Math.abs(lone / n - 1 / 6) < 0.02, `lone ayah share ${lone / n}`);
});

test('picker: exclusions avoid repeats and report exhaustion', () => {
  const ranges = [{ type: 'surah', from: [1, 1], to: [1, 7] }];
  const seen = new Set();
  const rng = seeded(3);
  for (let i = 0; i < 7; i++) {
    const { id, exhausted } = pickRandom(quran, ranges, { exclude: seen, rng });
    assert.equal(exhausted, false);
    assert.ok(!seen.has(id));
    seen.add(id);
  }
  assert.equal(pickRandom(quran, ranges, { exclude: seen, rng }).exhausted, true);
});

test('data: no stray tatweel after letters that cannot join (issue #6)', () => {
  const stray = /[اأإآٱدذرزوؤةء][ً-ٰٟۖ-ۭ]*ـ/;
  const bad = raw.ar.map((t, i) => (stray.test(t) ? i + 1 : 0)).filter(Boolean);
  assert.deepEqual(bad, []);
  assert.match(quran.verse(quran.idFor(56, 64)).arabic, /\u0632\u0651\u064E\u0670\u0631/); // زَّٰر
  assert.doesNotMatch(quran.verse(quran.idFor(2, 72)).arabic, /[ ـ]/);
});
