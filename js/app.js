import { loadQuran, JUZ_COUNT, PAGE_COUNT, VERSE_COUNT } from './data.js';
import { formatArabic, formatEnglish, splitWords } from './text.js';
import { pickRandom, rangeLabel, countVerses } from './picker.js';
import { loadState, saveState } from './store.js';
import { attachSwipe } from './gestures.js';
import { loadLayout, loadPageFont, preloadAround, buildPage, fitPage, firstWordOf, MushafUnavailable } from './mushaf.js';
import {
  pickQuestions, createChallenge, challengeUrl, challengeFromHash, decodeChallenge, addResult, mergeResults,
  ranked, score, formatScore, tally, cleanName, describeMode, MARKS, MAX_LABEL,
} from './challenge.js';

const APP_VERSION = '0.9.0-beta';
const MAX_PICK_HISTORY = 50;
const MAX_RECENT_CHALLENGES = 20;

const $ = (id) => document.getElementById(id);
const state = loadState();
let quran = null;

// Per-ayah view state; not persisted.
const view = {
  id: clampId(state.lastVerse),
  arabicHidden: false,
  englishHidden: false,
  revealedWords: 0,
  wordCount: 0,
  // A random pick waiting to be graded: { id, hinted }
  question: null,
};

// The rendered mushaf page, reused while the ayah stays on the same page.
const mushaf = { page: 0, root: null, words: [], token: 0 };

function clampId(id) {
  const n = Number(id);
  return Number.isInteger(n) && n >= 1 && n <= VERSE_COUNT ? n : 1;
}

// Settings as they apply right now: a challenge is shown the way its creator
// had Hasbuk set up, without changing the player's own settings.
function opts() {
  const run = state.run;
  if (!run) return state;
  return { ...state, arabic: run.challenge.mode.arabic, english: run.challenge.mode.english, hideInfo: run.hideInfo };
}

function persist() {
  state.lastVerse = view.id;
  saveState(state);
}

// ---------------------------------------------------------------- rendering

function render() {
  if (!quran) return;
  const v = quran.verse(view.id);
  const surah = quran.surah(v.surah);
  const o = opts();

  const info = $('info');
  info.classList.toggle('concealed', o.hideInfo);
  info.setAttribute('aria-label', o.hideInfo ? 'Location hidden. Tap to show.' : 'Tap to hide location');
  $('infoSurah').textContent = o.hideInfo ? '??' : `${surah.id}. ${surah.name}`;
  $('infoAyah').textContent = o.hideInfo ? '??' : v.ayah;
  $('infoJuz').textContent = o.hideInfo ? '??' : v.juz;
  $('infoPage').textContent = o.hideInfo ? '??' : v.page;
  info.title = o.hideInfo ? 'Tap to show where this ayah is' : `${surah.name} (${surah.meaning}) · tap to hide`;

  // Arabic: a single ayah, or the whole mushaf page around it
  const pageView = state.view === 'page';
  $('mushafBlock').hidden = !pageView;
  $('viewButton').setAttribute('aria-pressed', String(pageView));
  $('viewButton').title = pageView ? 'Show one ayah' : 'Show the mushaf page';
  if (pageView) updateMushaf();
  $('arabicBlock').hidden = pageView || o.arabic === 'off';
  if (!pageView && o.arabic !== 'off') {
    const words = splitWords(formatArabic(v.arabic, { showHizbMarker: state.showHizbMarker }));
    view.wordCount = words.length;
    const p = $('arabic');
    p.replaceChildren(...words.flatMap((w, i) => {
      const span = document.createElement('span');
      span.className = 'word';
      if (view.arabicHidden && i >= view.revealedWords) span.classList.add('masked');
      span.textContent = w;
      return i ? [document.createTextNode(' '), span] : [span];
    }));
    p.setAttribute('aria-label', view.arabicHidden ? 'Arabic hidden. Tap to reveal.' : '');
    $('arabicTools').hidden = !view.arabicHidden;
  }

  // English
  $('englishBlock').hidden = o.english === 'off';
  if (o.english !== 'off') {
    const p = $('english');
    p.textContent = formatEnglish(v.english, state.brackets);
    p.classList.toggle('masked', view.englishHidden);
    $('englishTools').hidden = !view.englishHidden;
  }

  $('prevButton').disabled = view.id <= 1;
  $('nextButton').disabled = view.id >= VERSE_COUNT;
  $('grade').hidden = !view.question;
  const running = Boolean(state.run);
  $('controls').hidden = running;
  $('challengeButton').hidden = running;
  $('tip').hidden = running;
  $('challengeBar').hidden = !running;
  if (running) renderChallengeBar();
  renderSession();
  persist();
}

async function updateMushaf() {
  const page = quran.pageOf(view.id);
  const token = ++mushaf.token;
  if (mushaf.page !== page || !mushaf.root) {
    setMushafStatus('Loading page…');
    const layoutPromise = loadLayout();
    const fontPromise = loadPageFont(page);
    fontPromise.catch(() => {}); // reported below, after the layout
    let layout;
    let family;
    try {
      layout = await layoutPromise;
      family = await fontPromise;
    } catch (err) {
      if (token !== mushaf.token) return;
      console.warn(err);
      mushaf.page = 0;
      mushaf.root = null;
      mushaf.words = [];
      $('mushafPage').replaceChildren();
      setMushafStatus(err instanceof MushafUnavailable
        ? 'The mushaf page view isn\'t available in this version yet.'
        : navigator.onLine === false
          ? 'This page isn\'t saved for offline use yet. Connect once to load it.'
          : 'Couldn\'t load this page. Check your connection and try again.', { error: true });
      return;
    }
    if (token !== mushaf.token) return;
    const { root, words } = buildPage(layout, page, { family, surahName: (n) => quran.surah(n).arabic });
    const footer = document.createElement('div');
    footer.className = 'mushaf-footer';
    $('mushafPage').replaceChildren(root, footer);
    Object.assign(mushaf, { page, root, words });
    setMushafStatus(null);
    fitPage(root);
    preloadAround(page);
  }
  applyMushafMarks();
}

// Highlights the ayah being tested and, when hidden, masks it and everything
// after it on the page; "Next word" reveals one word at a time from its start.
function applyMushafMarks() {
  const start = firstWordOf(mushaf.words, view.id);
  let counted = 0;
  let prevMasked = false;
  mushaf.words.forEach((w, i) => {
    let masked = false;
    if (view.arabicHidden && start !== -1 && i >= start) {
      if (w.end) {
        masked = prevMasked; // the ayah number shows with the word before it
      } else {
        counted++;
        masked = counted > view.revealedWords;
      }
    }
    prevMasked = masked;
    w.el.classList.toggle('masked', masked);
    w.el.classList.toggle('target', w.verse === view.id);
  });
  view.wordCount = counted;
  const footer = $('mushafPage').querySelector('.mushaf-footer');
  if (footer) footer.textContent = opts().hideInfo ? '' : String(mushaf.page);
  $('mushafTools').hidden = !view.arabicHidden;
}

function setMushafStatus(text, { error = false } = {}) {
  const el = $('mushafStatus');
  el.hidden = !text;
  el.classList.toggle('error', error);
  $('mushafStatusText').textContent = text || '';
}

function renderSession() {
  const s = state.session;
  const answered = s.correct + s.hinted + s.missed;
  $('sessionBar').hidden = Boolean(state.run) || (answered === 0 && s.picks.length < 2);
  const parts = [`✓ ${s.correct}`];
  if (s.hinted) parts.push(`with hints ${s.hinted}`);
  parts.push(`✗ ${s.missed}`);
  if (s.streak >= 3) parts.push(`🔥 ${s.streak}`);
  else if (s.best >= 3) parts.push(`best streak ${s.best}`);
  $('sessionStats').textContent = parts.join(' · ');
  $('lastPickButton').hidden = s.picks.length < 2;
}

function renderRangesSummary() {
  const r = state.ranges;
  const text = r.length === 0 ? 'Whole Quran'
    : r.length === 1 ? rangeLabel(quran, r[0])
    : `${rangeLabel(quran, r[0])} +${r.length - 1}`;
  $('rangesSummary').textContent = text;
  $('rangesButton').setAttribute('aria-label', `Ranges: ${text}. Change what to test.`);
  $('rangeCount').textContent = `${countVerses(quran, r).toLocaleString()} ayahs in range`;
}

function applyAppearance() {
  const root = document.documentElement;
  if (state.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = state.theme;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m) => {
    const forced = state.theme === 'dark' ? '#121614' : state.theme === 'light' ? '#f6f3ec' : null;
    m.content = forced ?? (m.media.includes('dark') ? '#121614' : '#f6f3ec');
  });
  root.style.setProperty('--arabic-size', `${state.arabicSize}px`);
  root.style.setProperty('--english-size', `${state.englishSize}px`);
  $('controls').classList.toggle('rtl', state.rtl);
}

let toastTimer;
function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- actions

function goTo(id, { keepReveal = false } = {}) {
  view.id = clampId(id);
  if (!keepReveal) {
    const o = opts();
    view.arabicHidden = o.arabic === 'reveal';
    view.englishHidden = o.english === 'reveal';
    view.revealedWords = 0;
  }
  render();
}

function step(delta) {
  const id = view.id + delta;
  if (id < 1 || id > VERSE_COUNT) return false;
  goTo(id);
  return true;
}

function next() { return step(1); }
function prev() { return step(-1); }

function randomAyah() {
  const s = state.session;
  const exclude = state.avoidRepeats ? new Set(s.seen) : new Set();
  // Never repeat the ayah on screen, even with repeats allowed.
  exclude.add(view.id);
  let { id, exhausted } = pickRandom(quran, state.ranges, { exclude });
  if (exhausted && state.avoidRepeats && s.seen.length) {
    s.seen = [];
    toast('Every ayah in range has come up. Starting a fresh round.');
    // New round: anything except the ayah on screen (unless it's the only one).
    ({ id } = pickRandom(quran, state.ranges, { exclude: new Set([view.id]) }));
  }
  if (state.avoidRepeats) s.seen.push(id);
  s.picks.push(id);
  if (s.picks.length > MAX_PICK_HISTORY) s.picks.splice(0, s.picks.length - MAX_PICK_HISTORY);
  view.question = { id, hinted: false };
  goTo(id);
}

function lastPick() {
  const picks = state.session.picks;
  if (picks.length < 2) return;
  picks.pop();
  const id = picks[picks.length - 1];
  view.question = { id, hinted: false };
  goTo(id);
}

function grade(result) {
  if (!view.question) return;
  if (state.run) {
    gradeChallenge(result);
    return;
  }
  const s = state.session;
  if (result === 'got' && !view.question.hinted) {
    s.correct++;
    s.streak++;
    s.best = Math.max(s.best, s.streak);
  } else if (result === 'got') {
    s.hinted++;
    s.streak = 0;
  } else {
    s.missed++;
    s.streak = 0;
  }
  view.question = null;
  randomAyah();
}

function resetSession() {
  state.session = { correct: 0, hinted: 0, missed: 0, streak: 0, best: 0, seen: [], picks: [] };
  view.question = null;
  render();
  toast('Session reset');
}

function hintWord() {
  if (!view.arabicHidden) return;
  view.revealedWords++;
  if (view.question) view.question.hinted = true;
  if (view.revealedWords >= view.wordCount) view.arabicHidden = false;
  render();
}

function toggleArabic() {
  if (opts().arabic === 'off' && state.view !== 'page') return;
  view.arabicHidden = !view.arabicHidden;
  view.revealedWords = 0;
  render();
}

function toggleEnglish() {
  if (opts().english === 'off') return;
  view.englishHidden = !view.englishHidden;
  render();
}

function toggleInfo() {
  if (state.run) state.run.hideInfo = !state.run.hideInfo;
  else state.hideInfo = !state.hideInfo;
  render();
}

// In page view a swipe turns the page; Prev/Next still move one ayah.
function pageStep(delta) {
  const page = quran.pageOf(view.id) + delta;
  if (page < 1 || page > PAGE_COUNT) return false;
  goTo(quran.pageRange(page)[0]);
  return true;
}

function forward() { return state.view === 'page' ? pageStep(1) : next(); }
function backward() { return state.view === 'page' ? pageStep(-1) : prev(); }

// Swipe left (or press →) to go forward, like a carousel. In RTL mode it's the
// mushaf way round: swipe right (turning a page) or press ← to go forward.
function swipeLeft() { return state.rtl ? backward() : forward(); }
function swipeRight() { return state.rtl ? forward() : backward(); }

function toggleView() {
  state.view = state.view === 'page' ? 'ayah' : 'page';
  render();
}

// ---------------------------------------------------------------- challenges

function rangesText() {
  const text = state.ranges.length ? state.ranges.map((r) => rangeLabel(quran, r)).join(', ') : 'Whole Quran';
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

function verseRef(id) {
  const v = quran.verse(id);
  return `${quran.surah(v.surah).name} ${v.surah}:${v.ayah}`;
}

function findEntry(id) {
  return state.challenges.find((e) => e.challenge.id === id) || null;
}

function myResult(entry) {
  return entry?.me ? entry.challenge.results.find((r) => r.name === entry.me) || null : null;
}

// Saves a challenge (newest first), keeping what we knew about it before.
function remember(challenge, me) {
  const old = findEntry(challenge.id);
  const entry = { ...old, challenge, me: me ?? old?.me ?? null };
  state.challenges = [entry, ...state.challenges.filter((e) => e.challenge.id !== challenge.id)]
    .slice(0, MAX_RECENT_CHALLENGES);
  saveState(state);
  return entry;
}

// A name from an input, or null after showing why it's needed.
function nameFrom(input) {
  const name = cleanName(input.value);
  input.setCustomValidity(name ? '' : 'Enter a name so friends know whose score it is');
  if (!name) {
    input.reportValidity();
    input.focus();
    return null;
  }
  state.playerName = name;
  return name;
}

function openChallengeDialog() {
  $('challengeName').value = state.playerName;
  $('challengeName').setCustomValidity('');
  $('challengeFrom').textContent = `${rangesText()} (${countVerses(quran, state.ranges).toLocaleString()} ayahs)`;
  $('challengeMode').textContent = capitalise(describeMode(state));
  const recent = $('recentList');
  recent.replaceChildren(...state.challenges.map((entry) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const left = document.createElement('span');
    const right = document.createElement('span');
    const c = entry.challenge;
    left.textContent = `${c.label} · ${c.ids.length} ayahs`;
    const mine = myResult(entry);
    right.textContent = mine
      ? `${formatScore(mine.marks)} · ${c.results.length} played`
      : 'Not played yet';
    button.append(left, right);
    button.addEventListener('click', () => {
      $('challengeDialog').close();
      if (mine) openResults(c.id);
      else openIntro(c);
    });
    li.append(button);
    return li;
  }));
  $('recentChallenges').hidden = state.challenges.length === 0;
  openDialog($('challengeDialog'));
}

function newChallenge() {
  const by = nameFrom($('challengeName'));
  if (!by) return null;
  const size = Number($('challengeForm').elements.size.value);
  const ids = pickQuestions(quran, state.ranges, size);
  if (ids.length < size) toast(`There are only ${ids.length} ayahs in range, so the challenge has ${ids.length}.`);
  const challenge = createChallenge({
    ids, by, label: rangesText(), mode: { arabic: state.arabic, english: state.english, hideInfo: state.hideInfo },
  });
  remember(challenge, null).created = true;
  saveState(state);
  return challenge;
}

function openIntro(challenge) {
  const c = findEntry(challenge.id)?.challenge || challenge;
  const created = findEntry(c.id)?.created;
  $('introTitle').textContent = created ? 'Your challenge'
    : c.by ? `${c.by} challenged you` : 'You\'ve been challenged';
  $('introCount').textContent = `${c.ids.length} from ${c.label}`;
  $('introMode').textContent = capitalise(describeMode(c.mode));
  $('introScores').hidden = c.results.length === 0;
  renderBoard($('introBoard'), c, null);
  $('introName').value = state.playerName;
  $('introName').setCustomValidity('');
  $('introDialog').dataset.challenge = c.id;
  openDialog($('introDialog'));
}

function startFromIntro() {
  if (!nameFrom($('introName'))) return;
  const entry = findEntry($('introDialog').dataset.challenge);
  $('introDialog').close();
  if (entry) startRun(entry.challenge);
}

function startRun(challenge) {
  if (state.run && state.run.challenge.id !== challenge.id) toast('Your other challenge was stopped.');
  state.run = { challenge, index: 0, marks: '', hideInfo: challenge.mode.hideInfo };
  showQuestion();
}

function showQuestion() {
  const id = state.run.challenge.ids[state.run.index];
  view.question = { id, hinted: false };
  goTo(id);
}

function gradeChallenge(result) {
  const run = state.run;
  run.marks += result === 'got' ? (view.question.hinted ? MARKS.hinted : MARKS.got) : MARKS.missed;
  run.index++;
  view.question = null;
  if (run.index < run.challenge.ids.length) showQuestion();
  else finishRun();
}

function finishRun() {
  const { challenge, marks } = state.run;
  const result = addResult(challenge, state.playerName, marks);
  state.run = null;
  remember(challenge, result.name);
  goTo(view.id);
  openResults(challenge.id);
}

let quitArmedAt = 0;
let quitTimer;
function quitRun() {
  const button = $('quitChallengeButton');
  clearTimeout(quitTimer);
  if (Date.now() - quitArmedAt > 3000) {
    quitArmedAt = Date.now();
    button.textContent = 'Tap again to quit';
    quitTimer = setTimeout(() => { button.textContent = 'Quit'; }, 3000);
    return;
  }
  quitArmedAt = 0;
  button.textContent = 'Quit';
  state.run = null;
  view.question = null;
  goTo(view.id);
  toast('Challenge stopped. You can start it again from Challenge friends.');
}

function renderChallengeBar() {
  const { challenge: c, index, marks } = state.run;
  $('challengeProgress').textContent = `Ayah ${Math.min(index + 1, c.ids.length)} of ${c.ids.length}`;
  $('challengeLabel').textContent = c.by ? `${c.by}'s challenge · ${c.label}` : c.label;
  $('challengeDots').replaceChildren(...c.ids.map((_, i) => {
    const li = document.createElement('li');
    if (i < marks.length) li.className = marks[i];
    else if (i === index) li.className = 'current';
    return li;
  }));
}

function markDots(marks) {
  const ol = document.createElement('ol');
  ol.className = 'dots';
  ol.setAttribute('aria-hidden', 'true');
  ol.append(...[...marks].map((m) => {
    const li = document.createElement('li');
    li.className = m;
    return li;
  }));
  return ol;
}

// Names come from links anyone can write, so they only ever go in as text.
function renderBoard(list, challenge, me) {
  const rows = ranked(challenge.results);
  list.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    if (me && r.name === me) li.classList.add('me');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = 1 + rows.filter((o) => o.score > r.score).length;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = me && r.name === me ? `${r.name} (you)` : r.name;
    const scoreEl = document.createElement('span');
    scoreEl.className = 'score';
    scoreEl.textContent = formatScore(r.marks);
    const t = tally(r.marks);
    li.setAttribute('aria-label', `${name.textContent}: ${t.got} got it, ${t.hinted} with hints, ${t.missed} missed`);
    li.append(rank, name, scoreEl, markDots(r.marks));
    return li;
  }));
}

function openResults(id) {
  const entry = findEntry(id);
  const mine = myResult(entry);
  if (!mine) return;
  const c = entry.challenge;
  const t = tally(mine.marks);
  const place = 1 + c.results.filter((r) => score(r.marks) > score(mine.marks)).length;
  const summary = $('resultsSummary');
  const big = document.createElement('strong');
  big.textContent = formatScore(mine.marks);
  const parts = [`${t.got} got it`];
  if (t.hinted) parts.push(`${t.hinted} with hints`);
  parts.push(`${t.missed} missed`);
  summary.replaceChildren(big, parts.join(' · '));
  $('resultsTitle').textContent = c.results.length > 1 ? `You came ${ordinal(place)} of ${c.results.length}` : 'Challenge done';
  renderBoard($('resultsBoard'), c, entry.me);
  $('resultsHint').textContent = c.results.length > 1
    ? 'When more friends play, they\'ll send you a new link. Open it to update these scores.'
    : 'Send it to friends. When they play, they\'ll send you a link back with everyone\'s scores.';
  $('resultsAyahs').replaceChildren(...c.ids.map((verseId, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const mark = document.createElement('span');
    mark.className = `mark ${mine.marks[i]}`;
    button.append(mark, `${i + 1}. ${verseRef(verseId)}`);
    button.addEventListener('click', () => {
      $('resultsDialog').close();
      view.question = null;
      goTo(verseId);
    });
    li.append(button);
    return li;
  }));
  $('resultsDialog').dataset.challenge = id;
  openDialog($('resultsDialog'));
}

function shareText(entry) {
  const c = entry.challenge;
  const mine = myResult(entry);
  return mine
    ? `I got ${formatScore(mine.marks)} on a Hasbuk challenge: ${c.ids.length} ayahs from ${c.label}. Can you beat it?`
    : `Can you recite on from these ${c.ids.length} ayahs (${c.label})? Try my Hasbuk challenge.`;
}

async function shareChallenge(id) {
  const entry = findEntry(id);
  if (!entry) return;
  const url = challengeUrl(entry.challenge, location.href);
  const text = shareText(entry);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Hasbuk challenge', text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  await copyChallenge(id);
}

async function copyChallenge(id) {
  const entry = findEntry(id);
  if (!entry) return;
  const url = challengeUrl(entry.challenge, location.href);
  try {
    await navigator.clipboard.writeText(`${shareText(entry)}\n${url}`);
    toast('Link copied. Paste it to your friends.');
  } catch {
    window.prompt('Copy this link and send it to your friends:', url);
  }
}

// Opening a challenge link: "#c=..." in the address.
function receiveFromHash() {
  const code = challengeFromHash(location.hash);
  if (!code) return;
  history.replaceState(null, '', location.pathname + location.search);
  let incoming;
  try {
    incoming = decodeChallenge(code);
  } catch {
    toast('That challenge link is broken or cut off. Ask for it again.');
    return;
  }
  if (state.run?.challenge.id === incoming.id) {
    state.run.challenge.results = mergeResults(state.run.challenge.results, incoming.results);
    saveState(state);
    toast('You\'re in the middle of this challenge. Finish it to see everyone\'s scores.');
    return;
  }
  const known = findEntry(incoming.id);
  if (known) known.challenge.results = mergeResults(known.challenge.results, incoming.results);
  const entry = remember(known ? known.challenge : incoming);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  if (myResult(entry)) openResults(incoming.id);
  else openIntro(entry.challenge);
}

function setupChallenges() {
  $('challengeButton').addEventListener('click', openChallengeDialog);
  $('playChallengeButton').addEventListener('click', () => {
    const challenge = newChallenge();
    if (!challenge) return;
    $('challengeDialog').close();
    startRun(challenge);
  });
  $('sendChallengeButton').addEventListener('click', async () => {
    const challenge = newChallenge();
    if (!challenge) return;
    $('challengeDialog').close();
    await shareChallenge(challenge.id);
  });
  $('startChallengeButton').addEventListener('click', startFromIntro);
  $('quitChallengeButton').addEventListener('click', quitRun);
  $('shareResultsButton').addEventListener('click', () => shareChallenge($('resultsDialog').dataset.challenge));
  $('copyResultsButton').addEventListener('click', () => copyChallenge($('resultsDialog').dataset.challenge));
  // Enter in a name box starts, rather than submitting (which would close the sheet).
  for (const [input, action] of [['challengeName', 'playChallengeButton'], ['introName', 'startChallengeButton']]) {
    $(input).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $(action).click(); }
    });
    $(input).addEventListener('input', () => $(input).setCustomValidity(''));
  }
  window.addEventListener('hashchange', () => { if (quran) receiveFromHash(); });
}

// ---------------------------------------------------------------- ranges UI

function options(select, items, selected) {
  select.replaceChildren(...items.map(([value, label]) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if (value === selected) o.selected = true;
    return o;
  }));
}

const numberItems = (n) => Array.from({ length: n }, (_, i) => [i + 1, String(i + 1)]);

function surahItems() {
  return quran.surahs.map((s) => [s.id, `${s.id}. ${s.name}`]);
}

function renderRanges() {
  const list = $('rangeList');
  list.replaceChildren(...state.ranges.map((range, index) => buildRange(range, index)));
  renderRangesSummary();
}

function buildRange(range, index) {
  const el = document.createElement('div');
  el.className = 'range';
  const title = { surah: 'Surah range', juz: 'Juz range', page: 'Page range' }[range.type];
  el.innerHTML = `<div class="range-head"><span>${title}</span>
    <button type="button" class="link-button danger" data-remove>Remove</button></div>`;
  el.querySelector('[data-remove]').addEventListener('click', () => {
    state.ranges.splice(index, 1);
    saveState(state);
    renderRanges();
  });

  for (const end of ['from', 'to']) {
    const line = document.createElement('label');
    line.className = 'range-line';
    line.append(end === 'from' ? 'From' : 'To');
    if (range.type === 'surah') {
      const [s, a] = range[end];
      const surahSel = document.createElement('select');
      surahSel.setAttribute('aria-label', `${end} surah`);
      options(surahSel, surahItems(), s);
      const ayahSel = document.createElement('select');
      ayahSel.className = 'ayah';
      ayahSel.setAttribute('aria-label', `${end} ayah`);
      options(ayahSel, numberItems(quran.surah(s).verseCount), a);
      surahSel.addEventListener('change', () => {
        const ns = Number(surahSel.value);
        range[end] = [ns, end === 'from' ? 1 : quran.surah(ns).verseCount];
        orderRange(range, end);
      });
      ayahSel.addEventListener('change', () => {
        range[end] = [range[end][0], Number(ayahSel.value)];
        orderRange(range, end);
      });
      line.append(surahSel, ayahSel);
    } else {
      line.classList.add('single');
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `${end} ${range.type}`);
      options(sel, numberItems(range.type === 'juz' ? JUZ_COUNT : PAGE_COUNT), range[end]);
      sel.addEventListener('change', () => {
        range[end] = Number(sel.value);
        orderRange(range, end);
      });
      line.append(sel);
    }
    el.append(line);
  }
  return el;
}

// If an edit puts "from" after "to", move the other end to match.
function orderRange(range, changed) {
  const key = (end) => (range.type === 'surah' ? quran.idFor(...range[end]) : range[end]);
  if (key('from') > key('to')) {
    const other = changed === 'from' ? 'to' : 'from';
    range[other] = range.type === 'surah' ? [...range[changed]] : range[changed];
  }
  saveState(state);
  renderRanges();
}

function addRange(type) {
  const v = quran.verse(view.id);
  if (type === 'surah') {
    state.ranges.push({ type, from: [v.surah, 1], to: [v.surah, quran.surah(v.surah).verseCount] });
  } else if (type === 'juz') {
    state.ranges.push({ type, from: v.juz, to: v.juz });
  } else {
    state.ranges.push({ type, from: v.page, to: v.page });
  }
  saveState(state);
  renderRanges();
}

// ---------------------------------------------------------------- settings UI

function fillSettingsForm() {
  const form = $('settingsForm');
  for (const el of form.elements) {
    if (!el.name || !(el.name in state)) continue;
    if (el.type === 'radio') el.checked = state[el.name] === el.value;
    else if (el.type === 'checkbox') el.checked = Boolean(state[el.name]);
    else el.value = state[el.name];
  }
}

function onSettingsInput(e) {
  const el = e.target;
  if (!el.name || !(el.name in state)) return;
  const value = el.type === 'checkbox' ? el.checked
    : el.type === 'range' ? Number(el.value)
    : el.value;
  state[el.name] = value;
  if (el.name === 'arabic') { view.arabicHidden = value === 'reveal'; view.revealedWords = 0; }
  if (el.name === 'english') view.englishHidden = value === 'reveal';
  applyAppearance();
  render();
}

// ---------------------------------------------------------------- wiring

function openDialog(dialog) {
  if (dialog.open) return;
  dialog.showModal();
}

function setupDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    // Tap on the backdrop closes the sheet.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }
  $('settingsButton').addEventListener('click', () => { fillSettingsForm(); openDialog($('settingsDialog')); });
  $('rangesButton').addEventListener('click', () => { renderRanges(); openDialog($('rangesDialog')); });
  $('aboutButton').addEventListener('click', () => openDialog($('aboutDialog')));
  $('settingsForm').addEventListener('input', onSettingsInput);
  $('settingsForm').addEventListener('change', onSettingsInput);
  $('addSurahRange').addEventListener('click', () => addRange('surah'));
  $('addJuzRange').addEventListener('click', () => addRange('juz'));
  $('addPageRange').addEventListener('click', () => addRange('page'));
  $('clearRanges').addEventListener('click', () => { state.ranges = []; saveState(state); renderRanges(); });
  $('versionText').textContent = `v${APP_VERSION}`;
}

function setupControls() {
  $('randomButton').addEventListener('click', randomAyah);
  $('nextButton').addEventListener('click', next);
  $('prevButton').addEventListener('click', prev);
  $('hintButton').addEventListener('click', hintWord);
  $('revealButton').addEventListener('click', toggleArabic);
  $('revealEnglishButton').addEventListener('click', toggleEnglish);
  $('arabic').addEventListener('click', toggleArabic);
  $('mushafPage').addEventListener('click', toggleArabic);
  $('mushafHint').addEventListener('click', hintWord);
  $('mushafReveal').addEventListener('click', toggleArabic);
  $('viewButton').addEventListener('click', toggleView);
  new ResizeObserver(() => { if (mushaf.root) fitPage(mushaf.root); }).observe($('mushafPage'));
  $('english').addEventListener('click', toggleEnglish);
  $('info').addEventListener('click', toggleInfo);
  $('gradeGot').addEventListener('click', () => grade('got'));
  $('gradeMissed').addEventListener('click', () => grade('missed'));
  $('lastPickButton').addEventListener('click', lastPick);
  $('resetSessionButton').addEventListener('click', resetSession);
  attachSwipe($('card'), (direction) => {
    if (state.run) return false; // a challenge stays on its ayah
    return direction === 'left' ? swipeLeft() : swipeRight();
  });

  document.addEventListener('keydown', (e) => {
    if (!quran || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.target.closest('input, select, textarea')) return;
    const key = e.key.toLowerCase();
    const actions = {
      arrowright: swipeLeft,
      arrowleft: swipeRight,
      ' ': randomAyah,
      r: randomAyah,
      h: hintWord,
      a: toggleArabic,
      e: toggleEnglish,
      i: toggleInfo,
      p: toggleView,
      g: () => grade('got'),
      m: () => grade('missed'),
    };
    if (key === ' ' && e.target.closest('button')) return; // let Space press the focused button
    if (state.run && ['arrowright', 'arrowleft', ' ', 'r'].includes(key)) return;
    if (actions[key]) {
      e.preventDefault();
      actions[key]();
    }
  });
}

function setStatus(text, { error = false } = {}) {
  $('status').hidden = false;
  $('status').classList.toggle('error', error);
  $('statusText').textContent = text;
  $('retryButton').hidden = !error;
}

async function start() {
  setStatus('Loading the Quran…');
  try {
    quran = await loadQuran();
  } catch (err) {
    console.error(err);
    setStatus(navigator.onLine === false
      ? 'You seem to be offline, and the Quran data isn\'t saved on this device yet. Connect once and Hasbuk will work offline after that.'
      : 'Couldn\'t load the Quran data. Check your connection and try again.', { error: true });
    return;
  }
  // Drop ranges saved by a different data version that no longer make sense.
  state.ranges = state.ranges.filter((r) => ['surah', 'juz', 'page'].includes(r.type));
  if (!Array.isArray(state.challenges)) state.challenges = [];
  const run = state.run;
  if (run && !(Array.isArray(run.challenge?.ids) && run.index < run.challenge.ids.length)) state.run = null;
  $('status').hidden = true;
  for (const id of ['randomButton', 'prevButton', 'nextButton']) $(id).disabled = false;
  renderRangesSummary();
  if (state.run) showQuestion(); // pick up a challenge where it was left
  else goTo(view.id);
  receiveFromHash();
}

applyAppearance();
setupDialogs();
setupControls();
setupChallenges();
$('retryButton').addEventListener('click', start);
start();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('Service worker registration failed', err);
    });
  });
}
