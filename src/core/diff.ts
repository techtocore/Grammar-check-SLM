import type { Edit } from './types';
import { tokenize } from './tokenize';

interface Op {
  type: 'equal' | 'delete' | 'insert';
  /** Index into the original token array (for equal/delete). */
  a: number;
  /** Index into the corrected token array (for equal/insert). */
  b: number;
}

/**
 * Computes a longest-common-subsequence alignment between two token arrays and
 * returns the minimal edit script (equal / delete / insert operations).
 *
 * Uses an O(n*m) DP over a flat typed array. Sentence-sized inputs keep this
 * comfortably fast.
 */
function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * (m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', a: i, b: j });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      ops.push({ type: 'delete', a: i, b: -1 });
      i++;
    } else {
      ops.push({ type: 'insert', a: -1, b: j });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'delete', a: i++, b: -1 });
  while (j < m) ops.push({ type: 'insert', a: -1, b: j++ });
  return ops;
}

/**
 * Produces a list of {@link Edit}s that transform `original` into `corrected`,
 * with every edit mapped back to a precise character range in `original`.
 *
 * - Replacements/deletions map to the span of the affected original words.
 * - Deletions extend over one adjacent space so applying them never leaves a
 *   double space.
 * - Insertions are represented as zero-width edits anchored at a word boundary,
 *   which keeps them non-overlapping and safe to apply.
 */
export function diffWords(original: string, corrected: string): Edit[] {
  const aTokens = tokenize(original);
  const bTokens = tokenize(corrected);
  const ops = lcsOps(
    aTokens.map((t) => t.text),
    bTokens.map((t) => t.text),
  );

  const edits: Edit[] = [];
  let delBuf: number[] = [];
  let insBuf: number[] = [];
  let prevEqualA: number | null = null;

  const joinCorrected = (indices: number[]): string =>
    indices.map((k) => bTokens[k]!.text).join(' ');

  const flush = (nextEqualA: number | null): void => {
    if (delBuf.length === 0 && insBuf.length === 0) return;

    if (delBuf.length > 0) {
      const firstIdx = delBuf[0]!;
      const lastIdx = delBuf[delBuf.length - 1]!;

      if (insBuf.length > 0) {
        // Replacement of one or more words.
        const start = aTokens[firstIdx]!.start;
        const end = aTokens[lastIdx]!.end;
        edits.push({
          kind: 'replace',
          start,
          end,
          original: original.slice(start, end),
          suggestion: joinCorrected(insBuf),
        });
      } else {
        // Pure deletion — consume one adjacent space for clean application.
        let start = aTokens[firstIdx]!.start;
        let end = aTokens[lastIdx]!.end;
        const nextToken = aTokens[lastIdx + 1];
        const prevToken = aTokens[firstIdx - 1];
        if (nextToken) {
          end = nextToken.start;
        } else if (prevToken) {
          start = prevToken.end;
        }
        edits.push({
          kind: 'delete',
          start,
          end,
          original: original.slice(start, end),
          suggestion: '',
        });
      }
    } else {
      // Pure insertion — anchor to a neighbouring word as a zero-width edit.
      const insertText = joinCorrected(insBuf);
      if (nextEqualA !== null) {
        const anchor = aTokens[nextEqualA]!;
        edits.push({
          kind: 'insert',
          start: anchor.start,
          end: anchor.start,
          original: '',
          suggestion: `${insertText} `,
        });
      } else if (prevEqualA !== null) {
        const anchor = aTokens[prevEqualA]!;
        edits.push({
          kind: 'insert',
          start: anchor.end,
          end: anchor.end,
          original: '',
          suggestion: ` ${insertText}`,
        });
      } else {
        edits.push({
          kind: 'insert',
          start: 0,
          end: original.length,
          original,
          suggestion: insertText,
        });
      }
    }

    delBuf = [];
    insBuf = [];
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      flush(op.a);
      prevEqualA = op.a;
    } else if (op.type === 'delete') {
      delBuf.push(op.a);
    } else {
      insBuf.push(op.b);
    }
  }
  flush(null);

  return edits.filter((e) => e.original !== e.suggestion);
}
