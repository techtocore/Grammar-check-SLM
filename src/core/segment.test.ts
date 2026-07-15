import { describe, it, expect } from 'vitest';
import { segmentSentences, splitLongSentence } from './segment';

describe('segmentSentences', () => {
  it('returns an empty array for blank input', () => {
    expect(segmentSentences('')).toEqual([]);
    expect(segmentSentences('   \n  ')).toEqual([]);
  });

  it('splits a paragraph into sentences with accurate offsets', () => {
    const text = 'Hello world. How are you?';
    const sentences = segmentSentences(text);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toEqual({ text: 'Hello world.', start: 0, end: 12 });
    expect(sentences[1]!.text).toBe('How are you?');
    // Offsets must point at the real characters in the source.
    for (const s of sentences) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('keeps a single sentence without terminal punctuation', () => {
    const sentences = segmentSentences('this is one line');
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.text).toBe('this is one line');
  });

  it('falls back safely for a malformed locale', () => {
    expect(segmentSentences('This still works.', 'not_a_locale')).toEqual([
      { text: 'This still works.', start: 0, end: 17 },
    ]);
  });

  it('retains unterminated lines when Intl.Segmenter is unavailable', () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
    try {
      const text = 'First line\nSecond line';
      const sentences = segmentSentences(text);
      expect(sentences.map((sentence) => sentence.text)).toEqual(['First line', 'Second line']);
      for (const sentence of sentences) {
        expect(text.slice(sentence.start, sentence.end)).toBe(sentence.text);
      }
    } finally {
      Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: original });
    }
  });

  it('preserves offsets for every sentence in multi-sentence text', () => {
    const text = 'First one! Second two? Third three.';
    const sentences = segmentSentences(text);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    for (const s of sentences) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });
});

describe('splitLongSentence', () => {
  it('returns the sentence unchanged when within the limit', () => {
    const s = { text: 'short one', start: 0, end: 9 };
    expect(splitLongSentence(s, 100)).toEqual([s]);
  });

  it('splits a long run-on into word-aligned chunks with correct offsets', () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const full = `xx ${words}`; // sentence starts at offset 3
    const sentence = { text: words, start: 3, end: 3 + words.length };
    const chunks = splitLongSentence(sentence, 50);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(50);
      expect(full.slice(c.start, c.end)).toBe(c.text); // offsets map back exactly
    }
    expect(chunks.map((c) => c.text).join(' ')).toBe(words); // no words lost
  });

  it('hard-splits an oversized unspaced token', () => {
    const text = 'a'.repeat(321);
    const sentence = { text, start: 0, end: text.length };
    const chunks = splitLongSentence(sentence, 320);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.text.length <= 320)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
  });

  it('splits long CJK text and keeps surrogate pairs intact', () => {
    const text = `${'界'.repeat(319)}😀${'語'.repeat(321)}`;
    const sentence = { text, start: 7, end: 7 + text.length };
    const full = `${' '.repeat(7)}${text}`;
    const chunks = splitLongSentence(sentence, 320);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 320)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(chunks.every((chunk) => full.slice(chunk.start, chunk.end) === chunk.text)).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text))).toBe(
      true,
    );
  });

  it('rejects a non-positive maximum length', () => {
    expect(() => splitLongSentence({ text: 'long', start: 0, end: 4 }, 0)).toThrow(RangeError);
  });

  it('keeps a grapheme intact when it exceeds the maximum length', () => {
    const text = '😀x';
    const chunks = splitLongSentence({ text, start: 0, end: text.length }, 1);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['😀', 'x']);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text))).toBe(
      true,
    );
  });
});
