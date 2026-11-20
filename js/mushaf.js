// Mushaf page view: renders a page of the 1405 AH Madinah mushaf exactly as
// printed, from data/mushaf-1405.json (scripts/build-mushaf.cjs) and the QPC V1
// per-page fonts in fonts/qcf-v1/. Each word is one glyph run in its page's
// font, laid out line by line, so lines justify the way the print does.

const LAYOUT_URL = 'data/mushaf-1405.json';
const BASMALA = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ';

let layoutPromise = null;
const fontPromises = new Map();

export class MushafUnavailable extends Error {}

export function loadLayout() {
  if (!layoutPromise) {
    layoutPromise = fetch(LAYOUT_URL)
      .then((res) => {
        if (res.status === 404) throw new MushafUnavailable('Mushaf data not installed');
        if (!res.ok) throw new Error(`Could not load the mushaf layout (HTTP ${res.status})`);
        return res.json();
      })
      .catch((err) => {
        layoutPromise = null;
        throw err;
      });
  }
  return layoutPromise;
}

export function loadPageFont(page) {
  if (!fontPromises.has(page)) {
    const family = `qcf-p${page}`;
    const face = new FontFace(family, `url(fonts/qcf-v1/p${page}.woff2) format("woff2")`, { display: 'block' });
    const promise = face.load()
      .then((loaded) => {
        document.fonts.add(loaded);
        return family;
      })
      .catch((err) => {
        fontPromises.delete(page);
        throw err;
      });
    fontPromises.set(page, promise);
  }
  return fontPromises.get(page);
}

// Warm the cache for the pages either side without blocking anything.
export function preloadAround(page) {
  for (const p of [page + 1, page - 1]) {
    if (p >= 1 && p <= 604) loadPageFont(p).catch(() => {});
  }
}

// Builds the page DOM. Returns the words in reading order so callers can
// highlight or mask them: [{ el, verse, end }], where `end` marks the
// ayah-number glyph closing that verse.
export function buildPage(layout, page, { family, surahName }) {
  const root = document.createElement('div');
  root.className = 'mushaf-page';
  root.dir = 'rtl';
  root.lang = 'ar';
  const words = [];

  for (const line of layout.pages[page - 1]) {
    const row = document.createElement('div');
    if (line[0] === 's') {
      row.className = 'mline surah-banner';
      const label = document.createElement('span');
      const surah = line[1];
      if (surah >= 2) {
        // QUL's surah header font: one calligraphic glyph per surah at U+E000 + n
        // (Al-Fatihah isn't in it, so it keeps the text banner).
        label.className = 'surah-glyph';
        label.textContent = String.fromCodePoint(0xE000 + surah);
        label.setAttribute('aria-label', `سُورَةُ ${surahName(surah)}`);
      } else {
        label.textContent = `سُورَةُ ${surahName(surah)}`;
      }
      row.append(label);
    } else if (line[0] === 'b') {
      row.className = 'mline basmala';
      row.textContent = BASMALA;
    } else {
      const [, centered, glyphs, runs] = line;
      row.className = centered ? 'mline centered' : 'mline';
      row.style.fontFamily = `"${family}"`;
      let i = 0;
      for (let r = 0; r < runs.length; r += 2) {
        const verse = Math.abs(runs[r]);
        const endsVerse = runs[r] < 0;
        for (let k = 0; k < runs[r + 1]; k++, i++) {
          const span = document.createElement('span');
          span.className = 'mw';
          span.textContent = glyphs[i];
          const end = endsVerse && k === runs[r + 1] - 1;
          if (end) span.classList.add('ayah-end');
          row.append(span);
          words.push({ el: span, verse, end });
        }
      }
    }
    root.append(row);
  }
  return { root, words };
}

// Scales the page's font so its widest justified line fills the width. The
// opening pages (all lines centred and short) use the typical page's scale.
const TYPICAL_SIZE_PER_WIDTH = 0.07;

export function fitPage(root) {
  const width = root.clientWidth;
  if (!width) return;
  root.style.fontSize = '100px';
  root.classList.add('measuring');
  let widest = 0;
  let justified = 0;
  for (const row of root.querySelectorAll('.mline:not(.surah-banner):not(.basmala)')) {
    let w = 0;
    for (const child of row.children) w += child.getBoundingClientRect().width;
    if (row.classList.contains('centered')) w += (row.children.length - 1) * 8; // the 0.08em gaps
    else justified++;
    widest = Math.max(widest, w);
  }
  root.classList.remove('measuring');
  if (!widest) return;
  let size = (100 * width * 0.97) / widest;
  if (!justified) size = Math.min(size, width * TYPICAL_SIZE_PER_WIDTH);
  root.style.fontSize = `${Math.floor(size * 10) / 10}px`;
}

// Index of the first word of `verse` on the page, or -1.
export function firstWordOf(words, verse) {
  return words.findIndex((w) => w.verse === verse);
}
