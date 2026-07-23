import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEditorDraft,
  loadEditorDraft,
  loadEditorDraftState,
  normalizeEditorDraft,
  saveEditorDraft,
  saveEditorDraftResult,
} from './editor-draft';

function installStorage(initial?: unknown) {
  const values: Record<string, unknown> = {};
  if (initial !== undefined) values.popupEditorDraft = structuredClone(initial);
  const get = vi.fn((key: string) => Promise.resolve({ [key]: structuredClone(values[key]) }));
  const set = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(values, structuredClone(patch));
    return Promise.resolve();
  });
  vi.stubGlobal('chrome', { storage: { local: { get, set } } });
  return { values, get, set };
}

describe('editor draft storage', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('restores text with a matching correction result', () => {
    expect(
      normalizeEditorDraft({
        version: 1,
        text: 'These is ready.',
        corrections: [
          {
            start: 0,
            end: 5,
            original: 'These',
            suggestion: 'This',
            kind: 'replace',
          },
        ],
      }),
    ).toEqual({
      text: 'These is ready.',
      corrections: [
        {
          start: 0,
          end: 5,
          original: 'These',
          suggestion: 'This',
          kind: 'replace',
        },
      ],
    });
  });

  it('keeps the text but drops a stale or malformed result', () => {
    expect(
      normalizeEditorDraft({
        version: 1,
        text: 'Current text',
        corrections: [
          {
            start: 0,
            end: 3,
            original: 'Old',
            suggestion: 'New',
            kind: 'replace',
          },
        ],
      }),
    ).toEqual({ text: 'Current text' });
  });

  it('persists, loads, and explicitly clears a draft', async () => {
    const storage = installStorage();
    const draft = {
      text: 'A paragraph worth keeping.',
      corrections: [],
      configKey: 'runner-a',
    };

    await saveEditorDraft({ sourceId: 'popup-a', sequence: 1, revision: 100, draft });
    await expect(loadEditorDraft()).resolves.toEqual(draft);
    await expect(loadEditorDraftState()).resolves.toEqual({ draft, revision: 100 });
    expect(storage.set).toHaveBeenCalledWith({
      popupEditorDraft: {
        version: 2,
        sourceId: 'popup-a',
        sequence: 1,
        revision: 100,
        text: draft.text,
        corrections: [],
        configKey: 'runner-a',
      },
    });

    await clearEditorDraft('popup-a', 2, 200);
    await expect(loadEditorDraft()).resolves.toBeNull();
    await expect(loadEditorDraftState()).resolves.toEqual({ draft: null, revision: 200 });
    expect(storage.values.popupEditorDraft).toEqual({
      version: 2,
      sourceId: 'popup-a',
      sequence: 2,
      revision: 200,
      text: '',
    });
  });

  it('ignores a stale write from the same editor instance', async () => {
    installStorage();

    await expect(
      saveEditorDraft({
        sourceId: 'popup-a',
        sequence: 2,
        revision: 200,
        draft: { text: 'Newest text' },
      }),
    ).resolves.toEqual({ applied: true, revision: 200 });
    await expect(
      saveEditorDraft({
        sourceId: 'popup-a',
        sequence: 1,
        revision: 100,
        draft: { text: 'Stale text' },
      }),
    ).resolves.toEqual({ applied: false, revision: 200 });

    await expect(loadEditorDraft()).resolves.toEqual({ text: 'Newest text' });
  });

  it('rejects an older write from a different editor instance', async () => {
    installStorage();

    await saveEditorDraft({
      sourceId: 'expanded',
      sequence: 1,
      revision: 300,
      draft: { text: 'Full-page edit' },
    });
    await expect(
      saveEditorDraft({
        sourceId: 'popup',
        sequence: 99,
        revision: 250,
        draft: { text: 'Delayed popup edit' },
      }),
    ).resolves.toEqual({ applied: false, revision: 300 });

    await expect(loadEditorDraft()).resolves.toEqual({ text: 'Full-page edit' });
  });

  it('attaches results only to the exact saved text revision', async () => {
    installStorage();
    const corrections = [
      {
        start: 0,
        end: 5,
        original: 'These',
        suggestion: 'This',
        kind: 'replace' as const,
      },
    ];
    await saveEditorDraft({
      sourceId: 'popup',
      sequence: 1,
      revision: 100,
      draft: { text: 'These are words.' },
    });

    await expect(
      saveEditorDraftResult({
        baseRevision: 100,
        text: 'These are words.',
        corrections,
        configKey: 'runner-a',
      }),
    ).resolves.toBe(true);
    await expect(loadEditorDraft()).resolves.toEqual({
      text: 'These are words.',
      corrections,
      configKey: 'runner-a',
    });

    await saveEditorDraft({
      sourceId: 'expanded',
      sequence: 1,
      revision: 200,
      draft: { text: 'Newer text.' },
    });
    await expect(
      saveEditorDraftResult({
        baseRevision: 100,
        text: 'These are words.',
        corrections,
        configKey: 'runner-a',
      }),
    ).resolves.toBe(false);
    await expect(loadEditorDraft()).resolves.toEqual({ text: 'Newer text.' });
  });
});
