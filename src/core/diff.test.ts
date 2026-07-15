import { describe, it, expect } from 'vitest';
import { diffWords } from './diff';
import { applyCorrections } from './corrections';
import type { Correction } from './types';

/** Helper: apply edits (which are offset-relative to `original`) back to text. */
function apply(original: string, edits: ReturnType<typeof diffWords>): string {
  const corrections: Correction[] = edits.map((e) => ({ ...e }));
  return applyCorrections(original, corrections);
}

describe('diffWords', () => {
  it('returns no edits for identical text', () => {
    expect(diffWords('Hello world', 'Hello world')).toEqual([]);
  });

  it('detects a single word replacement with exact offsets', () => {
    const edits = diffWords('I has a cat', 'I have a cat');
    expect(edits).toEqual([
      { kind: 'replace', start: 2, end: 5, original: 'has', suggestion: 'have' },
    ]);
    expect(apply('I has a cat', edits)).toBe('I have a cat');
  });

  it('detects multiple independent replacements', () => {
    const edits = diffWords('he do not likes it', 'he does not like it');
    expect(edits).toEqual([
      { kind: 'replace', start: 3, end: 5, original: 'do', suggestion: 'does' },
      { kind: 'replace', start: 10, end: 15, original: 'likes', suggestion: 'like' },
    ]);
    expect(apply('he do not likes it', edits)).toBe('he does not like it');
  });

  it('handles a deletion and consumes one adjacent space', () => {
    const original = 'I have a a cat';
    const edits = diffWords(original, 'I have a cat');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.kind).toBe('delete');
    expect(apply(original, edits)).toBe('I have a cat');
  });

  it('handles an insertion between two words', () => {
    const original = 'I a student';
    const edits = diffWords(original, 'I am a student');
    expect(edits).toEqual([{ kind: 'insert', start: 2, end: 2, original: '', suggestion: 'am ' }]);
    expect(apply(original, edits)).toBe('I am a student');
  });

  it('handles an insertion appended at the end', () => {
    const original = 'I am here';
    const edits = diffWords(original, 'I am here now');
    expect(edits).toEqual([{ kind: 'insert', start: 9, end: 9, original: '', suggestion: ' now' }]);
    expect(apply(original, edits)).toBe('I am here now');
  });

  it('handles an insertion at the start', () => {
    const original = 'world';
    const edits = diffWords(original, 'Hello world');
    expect(edits).toEqual([
      { kind: 'insert', start: 0, end: 0, original: '', suggestion: 'Hello ' },
    ]);
    expect(apply(original, edits)).toBe('Hello world');
  });

  it('handles insertions on both sides of the only word without overlap', () => {
    const original = 'X';
    const edits = diffWords(original, 'a X b');
    expect(edits).toHaveLength(2);
    // Non-overlapping zero-width inserts anchored at each boundary.
    expect(apply(original, edits)).toBe('a X b');
  });

  it('produces corrections that reconstruct the target for a realistic sentence', () => {
    const original = 'me and him was going too the store yesterday';
    const corrected = 'He and I were going to the store yesterday';
    const edits = diffWords(original, corrected);
    expect(edits.length).toBeGreaterThan(0);
    expect(apply(original, edits)).toBe(corrected);
    // Every edit maps to the substring it claims to replace.
    for (const e of edits) {
      expect(original.slice(e.start, e.end)).toBe(e.original);
    }
  });

  it('fixes punctuation/capitalization as a word replacement', () => {
    const edits = diffWords('hello world', 'Hello world.');
    expect(apply('hello world', edits)).toBe('Hello world.');
  });

  it('inserts Japanese text without synthesizing spaces', () => {
    const original = '私は学生です。';
    const corrected = '私は良い学生です。';
    expect(apply(original, diffWords(original, corrected, 'ja'))).toBe(corrected);
  });
});
