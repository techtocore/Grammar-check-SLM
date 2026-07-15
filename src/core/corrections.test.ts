import { describe, it, expect } from 'vitest';
import { assembleCorrections, applyCorrections, applyCorrection } from './corrections';
import { segmentSentences } from './segment';

describe('assembleCorrections', () => {
  it('maps per-sentence corrections to absolute offsets', () => {
    const text = 'I has a cat. He go home.';
    const sentences = segmentSentences(text);
    const corrected = ['I have a cat.', 'He goes home.'];
    const corrections = assembleCorrections(text, sentences, corrected);

    expect(corrections).toHaveLength(2);
    for (const c of corrections) {
      expect(text.slice(c.start, c.end)).toBe(c.original);
    }
    expect(applyCorrections(text, corrections)).toBe('I have a cat. He goes home.');
  });

  it('ignores sentences the model returned unchanged', () => {
    const text = 'This is fine.';
    const sentences = segmentSentences(text);
    expect(assembleCorrections(text, sentences, ['This is fine.'])).toEqual([]);
  });

  it('skips low-confidence rewrites (hallucination guard)', () => {
    const text = 'The cat sat.';
    const sentences = segmentSentences(text);
    const corrected = ['A large dog ran quickly across the entire yard today.'];
    expect(assembleCorrections(text, sentences, corrected)).toEqual([]);
  });

  it('skips same-length rewrites via the word-change ratio', () => {
    const text = 'The cat sat quietly.';
    const sentences = segmentSentences(text);
    // Almost every word changed but similar length -> rewrite, not a fix.
    expect(assembleCorrections(text, sentences, ['A big dog barked loudly.'])).toEqual([]);
  });

  it('skips insertion-only expansions via the word-change ratio', () => {
    const text = 'This sentence contains several ordinary words today.';
    const sentences = segmentSentences(text);
    const expanded = `${text} Aliens landed nearby yesterday with gifts.`;
    expect(assembleCorrections(text, sentences, [expanded])).toEqual([]);
  });

  it('keeps a small insertion needed for a grammar fix', () => {
    const text = 'I a student.';
    const sentences = segmentSentences(text);
    const corrections = assembleCorrections(text, sentences, ['I am a student.']);
    expect(applyCorrections(text, corrections)).toBe('I am a student.');
  });

  it('rejects a word-change ratio exactly at the configured limit', () => {
    const text = 'One two three four.';
    const sentences = segmentSentences(text);
    expect(
      assembleCorrections(text, sentences, ['Five six three four.'], { maxWordRatio: 0.5 }),
    ).toEqual([]);
  });

  it('keeps a legitimate multi-word fix', () => {
    const text = 'i wanna go their.';
    const sentences = segmentSentences(text);
    const corrections = assembleCorrections(text, sentences, ['I want to go there.']);
    expect(corrections.length).toBeGreaterThan(0);
    expect(applyCorrections(text, corrections)).toBe('I want to go there.');
  });

  it('aligns a narrow Japanese correction and rejects an unrelated rewrite', () => {
    const text = '私は猫が好きでし。';
    const sentences = segmentSentences(text, 'ja');
    const corrections = assembleCorrections(text, sentences, ['私は猫が好きです。'], {
      locale: 'ja',
    });
    expect(applyCorrections(text, corrections)).toBe('私は猫が好きです。');
    expect(
      assembleCorrections(text, sentences, ['明日は晴れた日になります。'], { locale: 'ja' }),
    ).toEqual([]);
  });

  it('respects a minimum sentence length', () => {
    const text = 'a';
    const sentences = segmentSentences(text);
    expect(assembleCorrections(text, sentences, ['A.'], { minSentenceLength: 3 })).toEqual([]);
  });

  it('handles a missing corrected entry gracefully', () => {
    const text = 'I has a cat.';
    const sentences = segmentSentences(text);
    expect(assembleCorrections(text, sentences, [])).toEqual([]);
  });
});

describe('applyCorrections', () => {
  it('applies multiple corrections right-to-left correctly', () => {
    const text = 'i has a cats';
    const corrections = [
      { start: 0, end: 1, original: 'i', suggestion: 'I', kind: 'replace' as const },
      { start: 2, end: 5, original: 'has', suggestion: 'have', kind: 'replace' as const },
      { start: 8, end: 12, original: 'cats', suggestion: 'cat', kind: 'replace' as const },
    ];
    expect(applyCorrections(text, corrections)).toBe('I have a cat');
  });

  it('applyCorrection applies a single edit', () => {
    expect(
      applyCorrection('I has a cat', {
        start: 2,
        end: 5,
        original: 'has',
        suggestion: 'have',
        kind: 'replace',
      }),
    ).toBe('I have a cat');
  });
});
