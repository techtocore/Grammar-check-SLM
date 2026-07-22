import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEditorDraft,
  loadEditorDraft,
  normalizeEditorDraft,
  saveEditorDraft,
} from './editor-draft';

function installStorage(initial?: unknown) {
  const values: Record<string, unknown> = {};
  if (initial !== undefined) values.popupEditorDraft = structuredClone(initial);
  const get = vi.fn((key: string) => Promise.resolve({ [key]: structuredClone(values[key]) }));
  const set = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(values, structuredClone(patch));
    return Promise.resolve();
  });
  const remove = vi.fn((key: string) => {
    delete values[key];
    return Promise.resolve();
  });
  vi.stubGlobal('chrome', { storage: { local: { get, set, remove } } });
  return { values, get, set, remove };
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
    };

    await saveEditorDraft(draft);
    await expect(loadEditorDraft()).resolves.toEqual(draft);
    expect(storage.set).toHaveBeenCalledWith({
      popupEditorDraft: {
        version: 1,
        text: draft.text,
        corrections: [],
      },
    });

    await clearEditorDraft();
    await expect(loadEditorDraft()).resolves.toBeNull();
    expect(storage.remove).toHaveBeenCalledWith('popupEditorDraft');
  });
});
