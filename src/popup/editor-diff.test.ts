import { describe, expect, it } from 'vitest';

import { buildEditorDiff } from './editor-diff';

describe('buildEditorDiff', () => {
  it('shows replacements as removed and added text', () => {
    expect(
      buildEditorDiff('This are fine.', [
        { start: 5, end: 8, original: 'are', suggestion: 'is', kind: 'replace' },
      ]),
    ).toEqual([
      { text: 'This ', kind: 'unchanged' },
      { text: 'are', kind: 'deletion' },
      { text: 'is', kind: 'addition' },
      { text: ' fine.', kind: 'unchanged' },
    ]);
  });

  it('keeps delete-only and insert-only corrections visible', () => {
    expect(
      buildEditorDiff('Too very good', [
        { start: 3, end: 8, original: ' very', suggestion: '', kind: 'delete' },
        { start: 13, end: 13, original: '', suggestion: '!', kind: 'insert' },
      ]),
    ).toEqual([
      { text: 'Too', kind: 'unchanged' },
      { text: ' very', kind: 'deletion' },
      { text: ' good', kind: 'unchanged' },
      { text: '!', kind: 'addition' },
    ]);
  });

  it('ignores overlapping corrections defensively', () => {
    expect(
      buildEditorDiff('abcdef', [
        { start: 1, end: 4, original: 'bcd', suggestion: 'B', kind: 'replace' },
        { start: 2, end: 3, original: 'c', suggestion: 'C', kind: 'replace' },
      ]),
    ).toEqual([
      { text: 'a', kind: 'unchanged' },
      { text: 'bcd', kind: 'deletion' },
      { text: 'B', kind: 'addition' },
      { text: 'ef', kind: 'unchanged' },
    ]);
  });
});
