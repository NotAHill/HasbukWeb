// Quran data access. Pure functions over the compact data file built by
// scripts/build-data.cjs, so they can be unit tested in Node.

export const VERSE_COUNT = 6236;
export const JUZ_COUNT = 30;
export const PAGE_COUNT = 604;

// Index of the last element in a sorted array that is <= value.
function floorIndex(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sorted[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function createQuran(raw) {
  const surahStarts = [];
  let next = 1;
  for (const s of raw.surahs) {
    surahStarts.push(next);
    next += s[3];
  }

  const surahs = raw.surahs.map(([arabic, name, meaning, verseCount], i) => ({
    id: i + 1, arabic, name, meaning, verseCount,
  }));

  function startOf(starts, index, total) {
    const first = starts[index];
    const last = index + 1 < starts.length ? starts[index + 1] - 1 : total;
    return [first, last];
  }

  return {
    surahs,

    surah(id) {
      return surahs[id - 1];
    },

    // Full location of a verse id.
    verse(id) {
      const s = floorIndex(surahStarts, id);
      return {
        id,
        surah: s + 1,
        ayah: id - surahStarts[s] + 1,
        juz: floorIndex(raw.juzStarts, id) + 1,
        page: floorIndex(raw.pageStarts, id) + 1,
        arabic: raw.ar[id - 1],
        english: raw.en[id - 1],
      };
    },

    idFor(surah, ayah) {
      const s = surahs[surah - 1];
      const a = Math.min(Math.max(1, ayah), s.verseCount);
      return surahStarts[surah - 1] + a - 1;
    },

    juzRange(juz) {
      return startOf(raw.juzStarts, juz - 1, VERSE_COUNT);
    },

    pageRange(page) {
      return startOf(raw.pageStarts, page - 1, VERSE_COUNT);
    },

    pageOf(id) {
      return floorIndex(raw.pageStarts, id) + 1;
    },
  };
}

export async function loadQuran(url = 'data/quran.min.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load Quran data (HTTP ${res.status})`);
  return createQuran(await res.json());
}
