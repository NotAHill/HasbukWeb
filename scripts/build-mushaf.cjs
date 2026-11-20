#!/usr/bin/env node
// Builds the 1405 AH Madinah mushaf page data from Quranic Universal Library
// (QUL) downloads (free account needed: https://qul.tarteel.ai):
//
//   1. Mushaf layout "KFGQPC V1 layout (1405H print)" (sqlite)
//        https://qul.tarteel.ai/resources/mushaf-layout/15
//   2. Quran script "QPC V1 Glyphs - Word by Word" (sqlite or json)
//        https://qul.tarteel.ai/resources/quran-script/57
//   3. Font "QPC V1 Font" (woff2, one file per page; optional here)
//        https://qul.tarteel.ai/resources/font/238
//
//   node scripts/build-mushaf.cjs --layout <layout.db> --words <words.db|words.json> [--fonts <dir>]
//
// Needs Node 22.13+ (node:sqlite).
//
// Writes data/mushaf-1405.json and, with --fonts, copies fonts/qcf-v1/p{1..604}.woff2.
// Output shape (read by js/mushaf.js):
//   { v, edition, pages: [ [line, ...] x604 ] }
//   line = ['s', surah]                 surah name banner
//        | ['b']                        basmala
//        | ['a', centered, glyphs, runs]
//   glyphs: the line's words, one string each (a word is one or more V1 glyph
//   characters; a ۞ marker rides with its word); runs: [verseId, count, ...]
//   counting words in order, with
//   verseId negated when the run ends that verse (its last word is then the
//   ayah-number marker).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function fail(msg) {
  console.error(`build-mushaf: ${msg}`);
  process.exit(1);
}

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!['layout', 'words', 'fonts'].includes(key) || !argv[i + 1]) fail(`unknown or empty argument ${argv[i]}`);
    out[key] = argv[i + 1];
  }
  if (!out.layout || !out.words) fail('usage: --layout <layout.db> --words <words.db|words.json> [--fonts <dir>]');
  return out;
}

function openDb(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    fail('node:sqlite is unavailable; use Node 22.13 or newer');
  }
  return new DatabaseSync(file, { readOnly: true });
}

function readWords(file) {
  if (file.endsWith('.json')) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    return list.map((w) => ({
      index: Number(w.word_index ?? w.id),
      surah: Number(w.surah),
      ayah: Number(w.ayah),
      text: String(w.text),
    }));
  }
  const db = openDb(file);
  return db.prepare('SELECT word_index, surah, ayah, text FROM words ORDER BY word_index')
    .all()
    .map((w) => ({ index: Number(w.word_index), surah: Number(w.surah), ayah: Number(w.ayah), text: String(w.text) }));
}

function main() {
  const opts = args();
  const quran = JSON.parse(fs.readFileSync(path.join(root, 'data', 'quran.min.json'), 'utf8'));

  const surahStart = [];
  let next = 1;
  for (const s of quran.surahs) { surahStart.push(next); next += s[3]; }
  const verseId = (surah, ayah) => surahStart[surah - 1] + ayah - 1;
  const pageOfVerse = (id) => {
    let p = 0;
    while (p + 1 < quran.pageStarts.length && quran.pageStarts[p + 1] <= id) p++;
    return p + 1;
  };

  const words = new Map();
  for (const w of readWords(opts.words)) {
    if (!Number.isInteger(w.index) || !w.text) fail(`bad word row ${JSON.stringify(w)}`);
    words.set(w.index, w);
  }

  // The last word of each ayah is its end marker.
  const lastWordOfVerse = new Map();
  for (const w of words.values()) {
    const id = verseId(w.surah, w.ayah);
    if (!(lastWordOfVerse.get(id) > w.index)) lastWordOfVerse.set(id, w.index);
  }
  if (lastWordOfVerse.size !== 6236) fail(`words cover ${lastWordOfVerse.size} ayahs, expected 6236`);

  const layout = openDb(opts.layout);
  const rows = layout.prepare(`SELECT page_number, line_number, line_type, is_centered, first_word_id,
      last_word_id, surah_number FROM pages ORDER BY page_number, line_number`).all();

  const pages = Array.from({ length: 604 }, () => []);
  const firstPageSeen = new Map();
  let lastVerse = 0;

  for (const r of rows) {
    const page = Number(r.page_number);
    if (page < 1 || page > 604) fail(`page ${page} out of range`);
    const lines = pages[page - 1];
    if (r.line_type === 'surah_name') {
      lines.push(['s', Number(r.surah_number)]);
    } else if (r.line_type === 'basmallah') {
      lines.push(['b']);
    } else if (r.line_type === 'ayah') {
      const glyphs = [];
      const runs = [];
      for (let i = Number(r.first_word_id); i <= Number(r.last_word_id); i++) {
        const w = words.get(i);
        if (!w) fail(`page ${page} line ${r.line_number}: word ${i} missing from the script`);
        const id = verseId(w.surah, w.ayah);
        if (id < lastVerse) fail(`verse order goes backwards at ${w.surah}:${w.ayah}`);
        lastVerse = id;
        if (!firstPageSeen.has(id)) firstPageSeen.set(id, page);
        glyphs.push(w.text);
        if (runs.length && Math.abs(runs[runs.length - 2]) === id) runs[runs.length - 1]++;
        else runs.push(id, 1);
        if (lastWordOfVerse.get(id) === i) runs[runs.length - 2] = -id;
      }
      lines.push(['a', r.is_centered ? 1 : 0, glyphs, runs]);
    } else {
      fail(`unknown line_type ${r.line_type} on page ${page}`);
    }
  }

  const empty = pages.findIndex((p) => p.length === 0);
  if (empty !== -1) fail(`page ${empty + 1} has no lines`);
  if (firstPageSeen.size !== 6236) fail(`layout places ${firstPageSeen.size} ayahs, expected 6236`);

  // The app's page numbers follow the 1405 print; a different layout would disagree.
  const mismatched = [...firstPageSeen].filter(([id, page]) => pageOfVerse(id) !== page);
  if (mismatched.length) {
    fail(`${mismatched.length} ayahs start on a different page than data/quran.min.json `
      + `(first: verse id ${mismatched[0][0]}). Is this the 1405 (V1) layout?`);
  }

  const out = { v: 1, edition: 'KFGQPC V1 (1405 AH print), layout and glyphs via QUL', pages };
  const outPath = path.join(root, 'data', 'mushaf-1405.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`Wrote ${path.relative(root, outPath)} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);

  if (opts.fonts) copyFonts(opts.fonts);
}

function copyFonts(dir) {
  const found = new Map();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.woff2$/i.test(entry.name)) {
        const m = entry.name.match(/(\d{1,3})\D*\.woff2$/i);
        if (m) found.set(Number(m[1]), full);
      }
    }
  };
  walk(dir);
  const missing = [];
  for (let p = 1; p <= 604; p++) if (!found.has(p)) missing.push(p);
  if (missing.length) fail(`fonts missing for ${missing.length} pages (first: ${missing[0]})`);
  const dest = path.join(root, 'fonts', 'qcf-v1');
  fs.mkdirSync(dest, { recursive: true });
  let bytes = 0;
  for (let p = 1; p <= 604; p++) {
    const to = path.join(dest, `p${p}.woff2`);
    fs.copyFileSync(found.get(p), to);
    bytes += fs.statSync(to).size;
  }
  console.log(`Copied 604 page fonts to fonts/qcf-v1 (${(bytes / 1048576).toFixed(1)} MB)`);
}

main();
