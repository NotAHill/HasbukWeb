// Range handling and random ayah selection.

import { VERSE_COUNT } from './data.js';

// A range as stored in settings:
//   { type: 'surah', from: [surah, ayah], to: [surah, ayah] }
//   { type: 'juz',   from: 1, to: 30 }
//   { type: 'page',  from: 1, to: 604 }
export function rangeToIds(quran, range) {
  let start;
  let end;
  if (range.type === 'surah') {
    start = quran.idFor(range.from[0], range.from[1]);
    end = quran.idFor(range.to[0], range.to[1]);
  } else if (range.type === 'juz') {
    start = quran.juzRange(Math.min(range.from, range.to))[0];
    end = quran.juzRange(Math.max(range.from, range.to))[1];
  } else if (range.type === 'page') {
    start = quran.pageRange(Math.min(range.from, range.to))[0];
    end = quran.pageRange(Math.max(range.from, range.to))[1];
  } else {
    throw new Error(`Unknown range type: ${range.type}`);
  }
  return start <= end ? { start, end } : { start: end, end: start };
}

// Sorted, non-overlapping intervals.
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end + 1) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

export function rangeLabel(quran, range) {
  if (range.type === 'juz') {
    return range.from === range.to ? `Juz ${range.from}` : `Juz ${range.from}–${range.to}`;
  }
  if (range.type === 'page') {
    return range.from === range.to ? `Page ${range.from}` : `Pages ${range.from}–${range.to}`;
  }
  const [fs, fa] = range.from;
  const [ts, ta] = range.to;
  const fromName = quran.surah(fs).name;
  const whole = fa === 1 && ta === quran.surah(ts).verseCount;
  if (fs === ts) return whole ? fromName : `${fromName} ${fa}–${ta}`;
  if (whole) return `${fromName} – ${quran.surah(ts).name}`;
  return `${fromName} ${fa} – ${quran.surah(ts).name} ${ta}`;
}

export function countVerses(quran, ranges) {
  const ivs = ranges.length
    ? mergeIntervals(ranges.map(r => rangeToIds(quran, r)))
    : [{ start: 1, end: VERSE_COUNT }];
  return ivs.reduce((n, iv) => n + iv.end - iv.start + 1, 0);
}

// Picks a page, then an ayah on that page, the way a teacher opens the mushaf.
// Each page is weighted by the share of its ayahs that are still available, so
// a range touching one ayah of a page doesn't give that ayah a whole page's odds.
//
// Returns { id, exhausted }. exhausted is true when every ayah in the ranges was
// excluded; the pick then ignores the exclusions and the caller should reset them.
export function pickRandom(quran, ranges, { exclude = new Set(), rng = Math.random } = {}) {
  const intervals = ranges.length
    ? mergeIntervals(ranges.map(r => rangeToIds(quran, r)))
    : [{ start: 1, end: VERSE_COUNT }];

  const build = (skip) => {
    const pages = new Map(); // page -> available ids
    for (const { start, end } of intervals) {
      for (let id = start; id <= end; id++) {
        if (skip.has(id)) continue;
        const page = quran.pageOf(id);
        if (!pages.has(page)) pages.set(page, []);
        pages.get(page).push(id);
      }
    }
    return pages;
  };

  let pages = build(exclude);
  let exhausted = false;
  if (pages.size === 0) {
    pages = build(new Set());
    exhausted = true;
  }

  const entries = [...pages].map(([page, ids]) => {
    const [first, last] = quran.pageRange(page);
    return { ids, weight: ids.length / (last - first + 1) };
  });
  const total = entries.reduce((s, e) => s + e.weight, 0);
  let r = rng() * total;
  let chosen = entries[entries.length - 1];
  for (const e of entries) {
    r -= e.weight;
    if (r < 0) { chosen = e; break; }
  }
  const id = chosen.ids[Math.min(chosen.ids.length - 1, Math.floor(rng() * chosen.ids.length))];
  return { id, exhausted };
}
