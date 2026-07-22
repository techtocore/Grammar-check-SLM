import type { Correction, EditKind } from '../core/types';

const STORAGE_KEY = 'popupEditorDraft';
const STORAGE_VERSION = 1;
const EDIT_KINDS = new Set<EditKind>(['replace', 'delete', 'insert']);

export interface EditorDraft {
  text: string;
  /** Present only when the saved result was produced for this exact text. */
  corrections?: Correction[];
}

interface StoredEditorDraft extends EditorDraft {
  version: typeof STORAGE_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCorrection(value: unknown, text: string): Correction | null {
  if (!isRecord(value)) return null;
  const { start, end, original, suggestion, kind } = value;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > text.length ||
    typeof original !== 'string' ||
    typeof suggestion !== 'string' ||
    typeof kind !== 'string' ||
    !EDIT_KINDS.has(kind as EditKind) ||
    original !== text.slice(start, end)
  ) {
    return null;
  }
  return { start, end, original, suggestion, kind: kind as EditKind };
}

/** Validates the editor state read from extension storage. */
export function normalizeEditorDraft(value: unknown): EditorDraft | null {
  if (!isRecord(value) || value.version !== STORAGE_VERSION || typeof value.text !== 'string') {
    return null;
  }
  const text = value.text;
  if (text.length === 0) return null;

  const draft: EditorDraft = { text };
  if (!('corrections' in value)) return draft;
  if (!Array.isArray(value.corrections)) return draft;

  const corrections = value.corrections.map((correction) => normalizeCorrection(correction, text));
  if (corrections.some((correction) => correction === null)) return draft;

  const validCorrections = corrections.filter(
    (correction): correction is Correction => correction !== null,
  );
  const sorted = [...validCorrections].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  for (const correction of sorted) {
    if (correction.start < cursor) return draft;
    cursor = Math.max(cursor, correction.end);
  }

  draft.corrections = validCorrections;
  return draft;
}

/** Loads the popup/full-page editor draft stored only on this device. */
export async function loadEditorDraft(): Promise<EditorDraft | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeEditorDraft(stored[STORAGE_KEY]);
}

/** Persists editor text and, when available, the matching correction result. */
export function saveEditorDraft(draft: EditorDraft): Promise<void> {
  if (draft.text.length === 0) return clearEditorDraft();
  const stored: StoredEditorDraft = {
    version: STORAGE_VERSION,
    text: draft.text,
    ...(draft.corrections === undefined
      ? {}
      : { corrections: draft.corrections.map((correction) => ({ ...correction })) }),
  };
  return chrome.storage.local.set({ [STORAGE_KEY]: stored });
}

/** Removes the saved editor state after the editor text is cleared. */
export function clearEditorDraft(): Promise<void> {
  return chrome.storage.local.remove(STORAGE_KEY);
}
