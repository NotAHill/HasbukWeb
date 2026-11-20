// Text preprocessing for display.

export const BRACKETS = {
  KEEP: 'keep', // [All] praise is [due] to Allah
  MARKS: 'marks', // All praise is due to Allah
  WORDS: 'words', // praise is to Allah
};

const RUB_EL_HIZB = '۞';

export function formatEnglish(text, brackets = BRACKETS.KEEP) {
  let out = text;
  if (brackets === BRACKETS.MARKS) {
    out = out.replace(/[[\]]/g, '');
  } else if (brackets === BRACKETS.WORDS) {
    out = out
      .replace(/\[[^\]]*\]/g, ' ')
      // Clauses emptied by the removal: "to you, , and" -> "to you, and"
      .replace(/([,;:])(\s*[,;:])+/g, '$1')
      .replace(/\s+([,.;:!?)])/g, '$1')
      .replace(/([("])\s+/g, '$1')
      .replace(/^[\s,;:]+/, '');
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function formatArabic(text, { showHizbMarker = false } = {}) {
  let out = text;
  if (!showHizbMarker) out = out.replace(RUB_EL_HIZB, '');
  return out.replace(/\s+/g, ' ').trim();
}

export function splitWords(text) {
  return text.split(' ').filter(Boolean);
}
