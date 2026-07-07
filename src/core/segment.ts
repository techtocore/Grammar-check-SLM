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

/**
 * Splits an over-long sentence (e.g. run-on or unpunctuated pasted text) into
 * word-aligned chunks no longer than `maxLen`, preserving absolute offsets, so
 * the model can handle it instead of the whole segment being skipped.
 */
export function splitLongSentence(sentence: Sentence, maxLen: number): Sentence[] {
  if (sentence.text.length <= maxLen) return [sentence];

  const result: Sentence[] = [];
  const text = sentence.text;
  const pushChunk = (startIdx: number, endIdx: number): void => {
    const raw = text.slice(startIdx, endIdx);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const start = sentence.start + startIdx + lead;
    result.push({ text: trimmed, start, end: start + trimmed.length });
  };

  const wordRe = /\S+/g;
  let match: RegExpExecArray | null;
  let chunkStart = 0;
  let lastWordEnd = 0;
  while ((match = wordRe.exec(text)) !== null) {
    const wordEnd = match.index + match[0].length;
    if (wordEnd - chunkStart > maxLen && lastWordEnd > chunkStart) {
      pushChunk(chunkStart, lastWordEnd);
      chunkStart = match.index;
    }
    lastWordEnd = wordEnd;
  }
  if (lastWordEnd > chunkStart) pushChunk(chunkStart, lastWordEnd);
  return result.length > 0 ? result : [sentence];
}
