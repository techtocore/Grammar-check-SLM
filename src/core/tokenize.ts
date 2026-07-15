import type { WordToken } from './types';

const WORD_RE = /\S+/g;

/**
 * Splits text into whitespace-delimited tokens, preserving the exact character
 * offsets of each token in the source string. Offsets make it possible to map
 * word-level diffs back to precise character ranges for highlighting/applying.
 */
export function tokenize(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function wordSegmenter(locale: string): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  try {
    return new Intl.Segmenter(locale.replaceAll('_', '-'), { granularity: 'word' });
  } catch {
    return new Intl.Segmenter('en', { granularity: 'word' });
  }
}

/** Locale-aware word tokens used for thresholds and rewrite detection. */
export function tokenizeWords(text: string, locale = 'en'): WordToken[] {
  const segmenter = wordSegmenter(locale);
  if (!segmenter) return tokenize(text);
  const tokens: WordToken[] = [];
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue;
    tokens.push({ text: part.segment, start: part.index, end: part.index + part.segment.length });
  }
  return tokens;
}

export function countWords(text: string, locale = 'en'): number {
  return tokenizeWords(text, locale).length;
}
