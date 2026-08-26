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

  it('rejects a conversational answer to a question', () => {
    const text = 'How are you doing?';
    const sentences = segmentSentences(text);
    const answer = 'I am doing well, thank you for asking.';

    expect(assembleCorrections(text, sentences, [answer])).toEqual([]);
  });

  it('rejects answers after a partial grammar correction', () => {
    const text = 'How are doing?';
    const sentences = segmentSentences(text);

    expect(
      assembleCorrections(text, sentences, ['I am doing well, thank you for asking.']),
    ).toEqual([]);
  });

  it('rejects answers to question-like text even when the question mark is missing', () => {
    const text = 'How are you doing';
    const sentences = segmentSentences(text);

    expect(assembleCorrections(text, sentences, ['I am doing well, thanks.'])).toEqual([]);
  });

  it('rejects answers to Japanese questions written with a question particle', () => {
    const text = '元気ですか';
    const sentences = segmentSentences(text, 'ja');

    expect(assembleCorrections(text, sentences, ['はい、元気です。'], { locale: 'ja' })).toEqual(
      [],
    );
  });

  it('preserves question intent while allowing grammar fixes', () => {
    const text = 'How is you doing?';
    const sentences = segmentSentences(text);
    const corrections = assembleCorrections(text, sentences, ['How are you doing?']);

    expect(applyCorrections(text, corrections)).toBe('How are you doing?');
  });

  it('rejects turning a question into a period-ended statement', () => {
    const examples = [
      ['How is you doing?', 'How are you doing.'],
      ['How is you doing', 'How are you doing.'],
    ] as const;

    for (const [text, candidate] of examples) {
      expect(assembleCorrections(text, segmentSentences(text), [candidate])).toEqual([]);
    }
  });

  it('allows corrected auxiliary agreement in a question', () => {
    const text = 'Is you ready?';
    const sentences = segmentSentences(text);
    const corrections = assembleCorrections(text, sentences, ['Are you ready?']);

    expect(applyCorrections(text, corrections)).toBe('Are you ready?');
  });

  it('allows tense correction within the do auxiliary family', () => {
    const text = 'Do you went home?';
    const sentences = segmentSentences(text);
    const corrections = assembleCorrections(text, sentences, ['Did you go home?']);

    expect(applyCorrections(text, corrections)).toBe('Did you go home?');
  });

  it('does not mistake an auxiliary-looking noun for an unpunctuated question', () => {
    const text = 'Can opener is dull.';
    const sentences = segmentSentences(text);
    const corrections = assembleCorrections(text, sentences, ['A can opener is dull.']);

    expect(applyCorrections(text, corrections)).toBe('A can opener is dull.');
  });

  it('allows joining an auxiliary-looking compound noun', () => {
    const text = 'Will power is useful.';
    const sentences = segmentSentences(text);
    const corrections = assembleCorrections(text, sentences, ['Willpower is useful.']);

    expect(applyCorrections(text, corrections)).toBe('Willpower is useful.');
  });

  it('honors period-ended declaratives with auxiliary-looking subjects', () => {
    const examples = [
      ['May 2024 were busy.', 'May 2024 was busy.'],
      ['Will Smith are here.', 'Will Smith is here.'],
    ] as const;

    for (const [text, candidate] of examples) {
      const corrections = assembleCorrections(text, segmentSentences(text), [candidate]);
      expect(applyCorrections(text, corrections)).toBe(candidate);
    }
  });

  it('rejects answers to unpunctuated questions with noun subjects', () => {
    const examples = [
      ['Can dogs eat bread', 'Yes, dogs can eat bread.'],
      ['Will the report arrive today', 'Yes, the report will arrive today.'],
    ] as const;

    for (const [text, candidate] of examples) {
      expect(assembleCorrections(text, segmentSentences(text), [candidate])).toEqual([]);
    }
  });

  it('recognizes contracted auxiliaries in unpunctuated questions', () => {
    const text = "Isn't this ready";
    const corrections = assembleCorrections(text, segmentSentences(text), ["Isn't this ready?"]);

    expect(applyCorrections(text, corrections)).toBe("Isn't this ready?");
  });

  it('rejects answers to unpunctuated contracted questions', () => {
    const examples = [
      ["Shouldn't we leave", "We shouldn't leave."],
      ["Won't dogs eat bread", "No, dogs won't eat bread."],
      ['Isn’t this ready', 'No, it isn’t ready.'],
    ] as const;

    for (const [text, candidate] of examples) {
      expect(assembleCorrections(text, segmentSentences(text), [candidate])).toEqual([]);
    }
  });

  it('preserves negation in contracted questions', () => {
    const text = "Won't dogs eat bread";

    expect(assembleCorrections(text, segmentSentences(text), ['Will dogs eat bread?'])).toEqual([]);
    const expanded = assembleCorrections(text, segmentSentences(text), [
      'Will dogs not eat bread?',
    ]);
    expect(applyCorrections(text, expanded)).toBe('Will dogs not eat bread?');
  });

  it('rejects modal paraphrases that change a question rather than correct it', () => {
    const text = 'Can you send the report?';
    const sentences = segmentSentences(text);

    expect(assembleCorrections(text, sentences, ['Could you send the report?'])).toEqual([]);
  });

  it('rejects newly introduced first-person contractions', () => {
    for (const candidate of [
      "I'm ready to help.",
      'I’m ready to help.',
      "I've been ready to help.",
    ]) {
      const text = 'Ready to help.';
      expect(assembleCorrections(text, segmentSentences(text), [candidate])).toEqual([]);
    }
  });

  it('allows apostrophe-only repairs to existing first-person contractions', () => {
    const examples = [
      ['Ive been ready.', "I've been ready."],
      ['Ill help.', "I'll help."],
      ['Weve started already.', "We've started already."],
    ] as const;

    for (const [text, candidate] of examples) {
      const corrections = assembleCorrections(text, segmentSentences(text), [candidate]);
      expect(applyCorrections(text, corrections)).toBe(candidate);
    }
  });

  it('rejects low-similarity paraphrases even when they retain one source word', () => {
    const text = 'Can you send the report?';
    const sentences = segmentSentences(text);

    expect(assembleCorrections(text, sentences, ['Sure, you will receive it shortly?'])).toEqual(
      [],
    );
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
