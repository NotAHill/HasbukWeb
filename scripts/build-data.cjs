#!/usr/bin/env node
// Builds data/quran.min.json (the file the app loads) from quran.json.
//
//   node scripts/build-data.cjs
//
// Output shape (see js/data.js for the reader):
//   { v, surahs: [[arabicName, transliteration, translation, verseCount]],
//     juzStarts: [verseId x30], pageStarts: [verseId x604],
//     ar: [text x6236], en: [text x6236] }
// Verse ids are 1-based and run 1..6236 in mushaf order.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'quran.json'), 'utf8'));

// Known defects in the upstream text (risan/quran-json 3.1.2).
const TEXT_FIXES = [
  {
    // 2:72 فَٱدَّٰرَٰٔتُمۡ — a stray THIN SPACE (U+2009) splits the word.
    surah: 2, ayah: 72, from: '\u2009', to: '',
  },
];

// A tatweel (U+0640) only draws a joining stroke when the letter before it
// joins forwards. After a letter that never does (ا د ذ ر ز و ء and their
// hamza forms), the text has one before a dagger alef (e.g. 56:64
// ٱلزَّـٰرِعُونَ), and it renders as a stray stroke with a gap (GitHub issue
// #6). Dropping it puts the dagger alef on the letter, as the mushaf has it.
const NON_JOINING = 'اأإآٱدذرزوؤةء';
const STRAY_TATWEEL = new RegExp(`([${NON_JOINING}][\\u064B-\\u065F\\u0670\\u06D6-\\u06ED]*)\\u0640`, 'g');

function fail(msg) {
  console.error(`build-data: ${msg}`);
  process.exit(1);
}

const surahs = [];
const ar = [];
const en = [];
const juzStarts = [];
const pageStarts = [];
let lastJuz = 0;
let lastPage = 0;

for (const s of source) {
  if (s.id !== surahs.length + 1) fail(`surah ids not contiguous at ${s.id}`);
  if (s.verses.length !== s.total_verses) fail(`surah ${s.id} verse count mismatch`);
  surahs.push([s.name, s.transliteration, s.translation, s.total_verses]);

  s.verses.forEach((v, i) => {
    if (v.id !== i + 1) fail(`verse numbering gap in surah ${s.id}`);
    const id = ar.length + 1;
    let text = v.text;
    for (const fix of TEXT_FIXES) {
      if (fix.surah === s.id && fix.ayah === v.id) {
        if (!text.includes(fix.from)) fail(`fix for ${s.id}:${v.id} no longer applies`);
        text = text.split(fix.from).join(fix.to);
      }
    }
    text = text.replace(STRAY_TATWEEL, '$1');
    ar.push(text);
    en.push(v.translation.replace(/\s+/g, ' ').trim());

    if (v.juz !== lastJuz) {
      if (v.juz !== lastJuz + 1) fail(`juz jumps from ${lastJuz} to ${v.juz} at ${s.id}:${v.id}`);
      juzStarts.push(id);
      lastJuz = v.juz;
    }
    if (v.pageNumber !== lastPage) {
      if (v.pageNumber !== lastPage + 1) fail(`page jumps from ${lastPage} to ${v.pageNumber} at ${s.id}:${v.id}`);
      pageStarts.push(id);
      lastPage = v.pageNumber;
    }
  });
}

if (surahs.length !== 114) fail(`expected 114 surahs, got ${surahs.length}`);
if (ar.length !== 6236) fail(`expected 6236 verses, got ${ar.length}`);
if (juzStarts.length !== 30) fail(`expected 30 juz, got ${juzStarts.length}`);
if (pageStarts.length !== 604) fail(`expected 604 pages, got ${pageStarts.length}`);
const stray = ar.findIndex(t => /[ -​]/.test(t));
if (stray !== -1) fail(`unexpected unicode space in verse id ${stray + 1}`);

const out = { v: 1, surahs, juzStarts, pageStarts, ar, en };
const outPath = path.join(root, 'data', 'quran.min.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${path.relative(root, outPath)} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
