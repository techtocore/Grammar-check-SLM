// Core domain types shared across the extension.

/** A whitespace-delimited token with its character offsets in the source string. */
export interface WordToken {
  text: string;
  /** Inclusive start offset in the source text. */
  start: number;
  /** Exclusive end offset in the source text. */
  end: number;
}

/** The nature of a single correction. */
export type EditKind = 'replace' | 'delete' | 'insert';

/**
 * A single edit relative to a source string. `start`/`end` describe the
 * character range in the *original* text that should be replaced with
 * `suggestion`. For insertions the range is zero-width (`start === end`).
 */
export interface Edit {
  kind: EditKind;
  start: number;
  end: number;
  original: string;
  suggestion: string;
}

/** A sentence extracted from a larger body of text, with absolute offsets. */
export interface Sentence {
  text: string;
  start: number;
  end: number;
}

/**
 * A correction mapped to absolute offsets in the full field text, ready to be
 * highlighted and applied.
 */
export interface Correction {
  start: number;
  end: number;
  original: string;
  suggestion: string;
  kind: EditKind;
}
