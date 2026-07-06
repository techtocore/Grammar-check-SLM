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
