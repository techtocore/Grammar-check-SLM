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
});
