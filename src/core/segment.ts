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
    let segmenter: Intl.Segmenter;
    try {
      segmenter = new Intl.Segmenter(locale.replaceAll('_', '-'), { granularity: 'sentence' });
    } catch {
      segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    }
    for (const { segment, index } of segmenter.segment(text)) {
      push(segment, index);
    }
    return sentences;
  }

  // Fallback: split on sentence-final punctuation followed by whitespace/end.
  const re = /[^.!?\n]+(?:[.!?]+|(?=\n|$))|[.!?]+/g;
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
  if (!Number.isInteger(maxLen) || maxLen < 1) {
    throw new RangeError('maxLen must be a positive integer');
  }
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

  const safeHardEnd = (start: number): number => {
    const limit = Math.min(start + maxLen, text.length);
    if (limit === text.length) return limit;

    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      let boundary = start;
      for (const part of graphemes.segment(text.slice(start))) {
        const candidate = start + part.index + part.segment.length;
        if (candidate > limit) {
          // A single extended grapheme may be longer than maxLen. Keep it
          // intact even though that one chunk must exceed the nominal limit.
          return boundary > start ? boundary : candidate;
        }
        boundary = candidate;
      }
      if (boundary > start) return boundary;
    }

    // A single grapheme can theoretically exceed a very small maxLen. Keep
    // the UTF-16 pair intact where possible, then make forward progress.
    const splitsSurrogatePair =
      limit > start &&
      /[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') &&
      /[\uDC00-\uDFFF]/.test(text[limit] ?? '');
    if (!splitsSurrogatePair) return limit;
    return limit - 1 > start ? limit - 1 : Math.min(limit + 1, text.length);
  };

  let chunkStart = 0;
  while (chunkStart < text.length) {
    while (/\s/.test(text[chunkStart] ?? '')) chunkStart++;
    if (chunkStart >= text.length) break;

    const limit = Math.min(chunkStart + maxLen, text.length);
    let chunkEnd = limit;
    if (limit < text.length) {
      const window = text.slice(chunkStart, limit + 1);
      const whitespace = [...window.matchAll(/\s+/g)].filter((match) => match.index > 0);
      const lastWhitespace = whitespace.at(-1);
      chunkEnd = lastWhitespace ? chunkStart + lastWhitespace.index : safeHardEnd(chunkStart);
    }

    pushChunk(chunkStart, chunkEnd);
    chunkStart = chunkEnd;
  }
  return result.length > 0 ? result : [sentence];
}
