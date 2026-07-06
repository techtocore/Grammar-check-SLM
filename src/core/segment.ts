import type { Sentence } from './types';

/**
 * Splits text into sentences with absolute offsets using the native
 * {@link Intl.Segmenter} (locale-aware, handles abbreviations/decimals far
 * better than a regex). Falls back to a simple punctuation split when the API
 * is unavailable.
 *
 * Leading/trailing whitespace is trimmed from each sentence while keeping the
 * offsets pointing at the real characters in the source.
 */
export function segmentSentences(text: string, locale = 'en'): Sentence[] {
  if (!text.trim()) return [];

  const sentences: Sentence[] = [];
  const push = (raw: string, rawStart: number): void => {
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const start = rawStart + lead;
    sentences.push({ text: trimmed, start, end: start + trimmed.length });
  };

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
    for (const { segment, index } of segmenter.segment(text)) {
      push(segment, index);
    }
    return sentences;
  }

  // Fallback: split on sentence-final punctuation followed by whitespace/end.
  const re = /[^.!?\n]*[.!?]+|\S[^.!?\n]*$/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    push(match[0], match.index);
  }
  return sentences;
}
