import { describe, it, expect } from 'vitest';
import { countWords, tokenize, tokenizeWords } from './tokenize';

describe('tokenize', () => {
  it('returns exact offsets for each word', () => {
    expect(tokenize('I has a cat')).toEqual([
      { text: 'I', start: 0, end: 1 },
      { text: 'has', start: 2, end: 5 },
      { text: 'a', start: 6, end: 7 },
      { text: 'cat', start: 8, end: 11 },
    ]);
  });

  it('handles leading/trailing and multiple spaces', () => {
    expect(tokenize('  hi   there ')).toEqual([
      { text: 'hi', start: 2, end: 4 },
      { text: 'there', start: 7, end: 12 },
    ]);
  });

  it('treats punctuation as part of the adjacent token', () => {
    expect(tokenize('Hello, world!')).toEqual([
      { text: 'Hello,', start: 0, end: 6 },
      { text: 'world!', start: 7, end: 13 },
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });

  it('counts words in languages that do not use spaces', () => {
    const text = '私は猫が好きです';
    expect(countWords(text, 'ja')).toBeGreaterThanOrEqual(3);
    for (const token of tokenizeWords(text, 'ja')) {
      expect(text.slice(token.start, token.end)).toBe(token.text);
    }
  });
});
