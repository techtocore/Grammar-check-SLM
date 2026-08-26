import type { Correction, Sentence } from './types';
import { diffWords } from './diff';
import { tokenizeWords } from './tokenize';

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
  /** Skip low-similarity output that is more likely a response or paraphrase than a correction. */
  minCharacterSimilarity?: number;
  /** Minimum sentence length (chars) to bother checking. */
  minSentenceLength?: number;
  /** Locale used for word segmentation and diff alignment. */
  locale?: string;
}

const DEFAULTS: Required<AssembleOptions> = {
  maxWordRatio: 0.85,
  maxLengthRatio: 2.2,
  minLengthRatio: 0.4,
  minCharacterSimilarity: 0.55,
  minSentenceLength: 2,
  locale: 'en',
};

const FIRST_PERSON_WORDS = new Set([
  'i',
  "i'm",
  'im',
  'me',
  'my',
  'mine',
  'myself',
  'we',
  "we're",
  'us',
  'our',
  'ours',
  'ourselves',
]);
const WH_QUESTION_WORDS = new Set(['who', 'what', 'when', 'where', 'why', 'which', 'whose', 'how']);
const QUESTION_AUXILIARIES = new Set([
  'am',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'have',
  'has',
  'had',
  'may',
  'might',
  'must',
]);
const AUXILIARY_CONTRACTIONS: Readonly<Record<string, string>> = {
  "isn't": 'is',
  "aren't": 'are',
  "wasn't": 'was',
  "weren't": 'were',
  "don't": 'do',
  "doesn't": 'does',
  "didn't": 'did',
  "can't": 'can',
  "couldn't": 'could',
  "won't": 'will',
  "wouldn't": 'would',
  "shan't": 'shall',
  "shouldn't": 'should',
  "haven't": 'have',
  "hasn't": 'has',
  "hadn't": 'had',
  "mayn't": 'may',
  "mightn't": 'might',
  "mustn't": 'must',
};
const ARTICLES = new Set(['a', 'an', 'the']);
const AUXILIARY_GROUPS: readonly ReadonlySet<string>[] = [
  new Set(['am', 'is', 'are']),
  new Set(['was', 'were']),
  new Set(['do', 'does', 'did']),
  new Set(['have', 'has', 'had']),
  new Set(['can']),
  new Set(['could']),
  new Set(['will']),
  new Set(['would']),
  new Set(['shall']),
  new Set(['should']),
  new Set(['may']),
  new Set(['might']),
  new Set(['must']),
];

function normalizedCharacters(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/** Levenshtein similarity normalized to 0..1. Sentences are bounded to 320 characters upstream. */
function characterSimilarity(source: string, candidate: string): number {
  const left = normalizedCharacters(source);
  const right = normalizedCharacters(candidate);
  if (left === right) return 1;
  if (!left || !right) return 0;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitution =
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        substitution,
      );
    }
    previous = current;
  }
  const distance = previous[right.length]!;
  return 1 - distance / Math.max(left.length, right.length);
}

function rawQuestionStarter(text: string, locale: string): string | undefined {
  return tokenizeWords(text, locale)[0]
    ?.text.toLocaleLowerCase()
    .replaceAll('\u2018', "'")
    .replaceAll('\u2019', "'");
}

function questionStarter(text: string, locale: string): string | undefined {
  const rawFirst = rawQuestionStarter(text, locale);
  const first = rawFirst ? (AUXILIARY_CONTRACTIONS[rawFirst] ?? rawFirst) : undefined;
  return first && (WH_QUESTION_WORDS.has(first) || QUESTION_AUXILIARIES.has(first))
    ? first
    : undefined;
}

function questionIsNegated(text: string, locale: string): boolean {
  return tokenizeWords(text, locale)
    .slice(0, 4)
    .some((token) => {
      const word = token.text
        .toLocaleLowerCase()
        .replaceAll('\u2018', "'")
        .replaceAll('\u2019', "'");
      return word === 'not' || Object.hasOwn(AUXILIARY_CONTRACTIONS, word);
    });
}

function implicitQuestionStarter(text: string, locale: string): string | undefined {
  return questionStarter(text, locale);
}

function hasQuestionMarker(text: string, locale: string): boolean {
  const trimmed = text.trim();
  if (/[?？][\s"'’”)\]}]*$/u.test(trimmed) || trimmed.startsWith('¿')) return true;
  if (!locale.toLocaleLowerCase().startsWith('ja')) return false;
  return /(?:か|の)(?:[。．…!！])?[\s"'’”)\]}]*$/u.test(trimmed);
}

function compatibleAuxiliary(source: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const group = AUXILIARY_GROUPS.find((auxiliaries) => auxiliaries.has(source));
  return group?.has(candidate) ?? false;
}

function isAuxiliaryLedDeclarativeRepair(
  source: string,
  candidate: string,
  locale: string,
): boolean {
  const sourceWords = tokenizeWords(source, locale).map((token) => token.text.toLocaleLowerCase());
  const candidateWords = tokenizeWords(candidate, locale).map((token) =>
    token.text.toLocaleLowerCase(),
  );
  const sourceFirst = sourceWords[0];
  if (!sourceFirst || !QUESTION_AUXILIARIES.has(sourceFirst)) return false;

  if (ARTICLES.has(candidateWords[0] ?? '') && candidateWords[1] === sourceFirst) {
    return true;
  }
  const sourceSecond = sourceWords[1];
  return sourceSecond !== undefined && candidateWords[0] === `${sourceFirst}${sourceSecond}`;
}

function preservesQuestionIntent(source: string, candidate: string, locale: string): boolean {
  const sourceHasQuestionMarker = hasQuestionMarker(source, locale);
  if (!sourceHasQuestionMarker && /[.。][\s"'’”)\]}]*$/u.test(source.trim())) {
    return true;
  }
  const sourceStarter = sourceHasQuestionMarker
    ? questionStarter(source, locale)
    : implicitQuestionStarter(source, locale);
  if (!sourceHasQuestionMarker && !sourceStarter) return true;
  if (!sourceHasQuestionMarker && isAuxiliaryLedDeclarativeRepair(source, candidate, locale)) {
    return true;
  }

  const candidateHasQuestionMarker = hasQuestionMarker(candidate, locale);
  const candidateStarter = questionStarter(candidate, locale);
  if (sourceHasQuestionMarker && !candidateHasQuestionMarker) return false;
  if (!candidateHasQuestionMarker && /[.!。！][\s"'’”)\]}]*$/u.test(candidate.trim())) {
    return false;
  }
  if (sourceStarter && questionIsNegated(source, locale) !== questionIsNegated(candidate, locale)) {
    return false;
  }
  if (sourceStarter && WH_QUESTION_WORDS.has(sourceStarter)) {
    return candidateStarter === sourceStarter;
  }
  if (sourceStarter) return compatibleAuxiliary(sourceStarter, candidateStarter);
  return candidateHasQuestionMarker;
}

function normalizedWord(word: string): string {
  return word.toLocaleLowerCase().replaceAll('\u2018', "'").replaceAll('\u2019', "'");
}

function compactWord(word: string): string {
  return normalizedWord(word).replaceAll("'", '');
}

function firstPersonForms(text: string, locale: string): Set<string> {
  const forms = new Set<string>();
  for (const token of tokenizeWords(text, locale)) {
    const normalized = normalizedWord(token.text);
    const contractionRoot = normalized.split("'", 1)[0] ?? normalized;
    if (FIRST_PERSON_WORDS.has(normalized) || contractionRoot === 'i' || contractionRoot === 'we') {
      forms.add(compactWord(normalized));
    }
  }
  return forms;
}

function introducesFirstPerson(source: string, candidate: string, locale: string): boolean {
  if (firstPersonForms(source, locale).size > 0) return false;
  const candidateForms = firstPersonForms(candidate, locale);
  if (candidateForms.size === 0) return false;
  const sourceWords = new Set(
    tokenizeWords(source, locale).map((token) => compactWord(token.text)),
  );
  return [...candidateForms].some((form) => !sourceWords.has(form));
}

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
  const {
    maxWordRatio,
    maxLengthRatio,
    minLengthRatio,
    minCharacterSimilarity,
    minSentenceLength,
    locale,
  } = {
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

    const edits = diffWords(sentence.text, cleanedCorrected, locale);
    if (edits.length === 0) continue;

    // Hallucination guards.
    const lengthRatio = cleanedCorrected.length / sentence.text.length;
    if (lengthRatio > maxLengthRatio || lengthRatio < minLengthRatio) continue;
    if (characterSimilarity(sentence.text, cleanedCorrected) < minCharacterSimilarity) continue;

    // A grammar correction must preserve the input's communicative role. These
    // checks deterministically reject common chat-style answers.
    if (!preservesQuestionIntent(sentence.text, cleanedCorrected, locale)) continue;
    if (introducesFirstPerson(sentence.text, cleanedCorrected, locale)) continue;

    const originalTokens = tokenizeWords(sentence.text, locale);
    const changedSourceTokens = originalTokens.filter((token) =>
      edits.some(
        (edit) => edit.kind !== 'insert' && token.start < edit.end && token.end > edit.start,
      ),
    ).length;
    const insertedTokens = edits
      .filter((edit) => edit.kind === 'insert')
      .reduce((count, edit) => count + tokenizeWords(edit.suggestion, locale).length, 0);
    const changedTokens = changedSourceTokens + insertedTokens;
    const wordRatio = originalTokens.length > 0 ? changedTokens / originalTokens.length : 0;
    if (originalTokens.length >= 3 && wordRatio >= maxWordRatio) continue;

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
