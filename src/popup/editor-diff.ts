import type { Correction } from '../core';

export type EditorDiffPart = {
  text: string;
  kind: 'unchanged' | 'deletion' | 'addition';
};

/** Builds a semantic before/after diff while ignoring overlapping corrections. */
export function buildEditorDiff(
  text: string,
  corrections: readonly Correction[],
): EditorDiffPart[] {
  const sorted = [...corrections].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: EditorDiffPart[] = [];
  let cursor = 0;

  for (const correction of sorted) {
    if (correction.start < cursor) continue;
    if (correction.start > cursor) {
      parts.push({ text: text.slice(cursor, correction.start), kind: 'unchanged' });
    }

    const removed = text.slice(correction.start, correction.end);
    if (removed) parts.push({ text: removed, kind: 'deletion' });
    if (correction.suggestion) {
      parts.push({ text: correction.suggestion, kind: 'addition' });
    }
    cursor = Math.max(cursor, correction.end);
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), kind: 'unchanged' });
  }
  return parts;
}
