import type { Correction, Sentence } from './types';
import { diffWords } from './diff';
import { tokenize } from './tokenize';

export interface AssembleOptions {
  /**
   * Skip a sentence when this fraction (or more) of its words were changed —
   * a strong signal the model rewrote rather than corrected it. Only applied to
   * sentences with at least a few words.
   */
  maxWordRatio?: number;
  /** Skip when the correction is more than this many times longer than the source. */
  maxLengthRatio?: number;
  /** Skip when the correction is shorter than this fraction of the source (truncation). */
  minLengthRatio?: number;
  /** Minimum sentence length (chars) to bother checking. */
  minSentenceLength?: number;
}

const DEFAULTS: Required<AssembleOptions> = {
  maxWordRatio: 0.75,
  maxLengthRatio: 2,
  minLengthRatio: 0.4,
  minSentenceLength: 2,
};

/**
 * Maps per-sentence model output to absolute-offset {@link Correction}s over the
 * full field text. Pure and deterministic — the heart of the checker's
 * correctness, fully unit-tested.
 *
 * Includes several hallucination guards so a generative SLM that paraphrases,
 * expands, or truncates a sentence (instead of merely fixing it) is silently
 * ignored rather than shown as a wall of bogus suggestions.
 */
export function assembleCorrections(
  text: string,
  sentences: readonly Sentence[],
  correctedSentences: readonly string[],
  options: AssembleOptions = {},
): Correction[] {
  const { maxWordRatio, maxLengthRatio, minLengthRatio, minSentenceLength } = {
    ...DEFAULTS,
    ...options,
  };
  const corrections: Correction[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const corrected = correctedSentences[i];
    if (!sentence || corrected === undefined) continue;
    if (sentence.text.length < minSentenceLength) continue;

    const cleanedCorrected = corrected.trim();
    if (!cleanedCorrected || cleanedCorrected === sentence.text.trim()) continue;

    const edits = diffWords(sentence.text, cleanedCorrected);
    if (edits.length === 0) continue;

    // Hallucination guards.
    const lengthRatio = cleanedCorrected.length / sentence.text.length;
    if (lengthRatio > maxLengthRatio || lengthRatio < minLengthRatio) continue;

    const originalTokens = tokenize(sentence.text);
    const changedTokens = originalTokens.filter((t) =>
      edits.some((e) => e.kind !== 'insert' && t.start < e.end && t.end > e.start),
    ).length;
    const wordRatio = originalTokens.length > 0 ? changedTokens / originalTokens.length : 0;
    if (originalTokens.length >= 3 && wordRatio > maxWordRatio) continue;

    for (const edit of edits) {
      corrections.push({
        start: sentence.start + edit.start,
        end: sentence.start + edit.end,
        original: edit.original,
        suggestion: edit.suggestion,
        kind: edit.kind,
      });
    }
  }

  return corrections;
}

/**
 * Applies a set of corrections to text, returning the corrected string.
 * Corrections are applied from right to left so earlier offsets stay valid.
 */
export function applyCorrections(text: string, corrections: readonly Correction[]): string {
  const sorted = [...corrections].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = text;
  for (const c of sorted) {
    result = result.slice(0, c.start) + c.suggestion + result.slice(c.end);
  }
  return result;
}

/** Applies a single correction to text. */
export function applyCorrection(text: string, correction: Correction): string {
  return text.slice(0, correction.start) + correction.suggestion + text.slice(correction.end);
}
