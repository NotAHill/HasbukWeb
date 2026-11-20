// Persistent settings and session state in localStorage. Every access is
// guarded: storage can be unavailable (private mode, blocked site data).

const KEY = 'hasbuk:v1';

export const DEFAULTS = {
  arabic: 'show', // 'show' | 'reveal' (hidden until tapped) | 'off'
  english: 'show',
  hideInfo: false,
  brackets: 'keep', // see BRACKETS in text.js
  showHizbMarker: false,
  arabicSize: 32,
  englishSize: 19,
  rtl: false, // swipe right / right-hand button for next, like turning mushaf pages
  avoidRepeats: true,
  theme: 'auto', // 'auto' | 'light' | 'dark'
  view: 'ayah', // 'ayah' | 'page' (1405 mushaf page)
  playerName: '',
  run: null, // challenge being played: { challenge, index, marks, hideInfo }
  challenges: [], // recent challenges, newest first: { challenge, me } (me: my result's name)
  live: null, // live room I'm in: { code, playerId, secret, create? (settings, until the room exists) }
  ranges: [],
  lastVerse: 1,
  session: { correct: 0, hinted: 0, missed: 0, streak: 0, best: 0, seen: [], picks: [] },
};

export function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    saved = {};
  }
  return {
    ...structuredClone(DEFAULTS),
    ...saved,
    session: { ...structuredClone(DEFAULTS.session), ...(saved.session || {}) },
  };
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not fatal: the app works without persistence.
  }
}
