import { describe, it, expect } from 'vitest';
import { segmentSentences } from './segment';

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
