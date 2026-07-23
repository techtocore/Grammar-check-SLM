import type { Correction, EditKind } from '../core/types';

const STORAGE_KEY = 'popupEditorDraft';
const LEGACY_STORAGE_VERSION = 1;
const STORAGE_VERSION = 2;
const EDIT_KINDS = new Set<EditKind>(['replace', 'delete', 'insert']);
let saveQueue: Promise<void> = Promise.resolve();

export interface EditorDraft {
  text: string;
  /** Present only when the saved result was produced for this exact text. */
  corrections?: Correction[];
  /** Runner settings used to produce the saved correction result. */
  configKey?: string;
}

export interface EditorDraftUpdate {
  sourceId: string;
  sequence: number;
  revision: number;
  draft: EditorDraft | null;
}

export interface EditorDraftResultUpdate {
  baseRevision: number;
  text: string;
  corrections: Correction[];
  configKey: string;
}

export interface LoadedEditorDraft {
  draft: EditorDraft | null;
  revision: number | null;
}

export interface EditorDraftWriteResult {
  applied: boolean;
  revision: number;
}

interface StoredEditorDraft extends EditorDraft {
  version: typeof STORAGE_VERSION;
  sourceId: string;
  sequence: number;
  revision: number;
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

function normalizeDraft(value: unknown, tolerateInvalidResult: boolean): EditorDraft | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  const text = value.text;
  if (text.length === 0) return null;

  const draft: EditorDraft = { text };
  if (!('corrections' in value)) return draft;
  if (!Array.isArray(value.corrections)) return tolerateInvalidResult ? draft : null;

  const corrections = value.corrections.map((correction) => normalizeCorrection(correction, text));
  if (corrections.some((correction) => correction === null)) {
    return tolerateInvalidResult ? draft : null;
  }

  const validCorrections = corrections.filter(
    (correction): correction is Correction => correction !== null,
  );
  const sorted = [...validCorrections].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  for (const correction of sorted) {
    if (correction.start < cursor) return tolerateInvalidResult ? draft : null;
    cursor = Math.max(cursor, correction.end);
  }

  const configKey = value.configKey;
  if (typeof configKey !== 'string' || configKey.length === 0 || configKey.length > 500) {
    if (!tolerateInvalidResult) return null;
  } else {
    draft.configKey = configKey;
  }
  if (!tolerateInvalidResult && draft.configKey === undefined) return null;
  draft.corrections = validCorrections;
  return draft;
}

/** Validates a draft supplied by an extension UI message. */
export function isEditorDraft(value: unknown): value is EditorDraft {
  return normalizeDraft(value, false) !== null;
}

/** Validates the editor state read from extension storage. */
export function normalizeEditorDraft(value: unknown): EditorDraft | null {
  if (!isRecord(value)) return null;
  if (value.version !== LEGACY_STORAGE_VERSION && value.version !== STORAGE_VERSION) return null;
  return normalizeDraft(value, true);
}

/** Loads the popup/full-page editor draft stored only on this device. */
export async function loadEditorDraftState(): Promise<LoadedEditorDraft> {
  await saveQueue;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  const draft = normalizeEditorDraft(value);
  const order = storedOrder(value);
  return { draft, revision: order?.revision ?? null };
}

/** Loads only the draft contents for callers that do not need revision metadata. */
export async function loadEditorDraft(): Promise<EditorDraft | null> {
  return (await loadEditorDraftState()).draft;
}

function normalizeUpdate(update: EditorDraftUpdate): EditorDraftUpdate {
  if (!update.sourceId || update.sourceId.length > 100) {
    throw new Error('The editor draft source is invalid.');
  }
  if (!Number.isSafeInteger(update.sequence) || update.sequence < 0) {
    throw new Error('The editor draft sequence is invalid.');
  }
  if (!Number.isSafeInteger(update.revision) || update.revision < 0) {
    throw new Error('The editor draft revision is invalid.');
  }
  if (update.draft === null) return { ...update };
  const draft = normalizeDraft(update.draft, false);
  if (!draft) throw new Error('The editor draft is invalid.');
  return { ...update, draft };
}

function storedOrder(
  value: unknown,
): Pick<StoredEditorDraft, 'sourceId' | 'sequence' | 'revision'> | null {
  if (
    !isRecord(value) ||
    value.version !== STORAGE_VERSION ||
    typeof value.sourceId !== 'string' ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision)
  ) {
    return null;
  }
  return {
    sourceId: value.sourceId,
    sequence: value.sequence,
    revision: value.revision,
  };
}

/**
 * Persists editor text through a serialized, source-sequenced write. A stale
 * message from the same popup instance can never overwrite a newer edit.
 */
export function saveEditorDraft(update: EditorDraftUpdate): Promise<EditorDraftWriteResult> {
  const normalized = normalizeUpdate(update);
  const operation = saveQueue.then(async () => {
    const current = await chrome.storage.local.get(STORAGE_KEY);
    const order = storedOrder(current[STORAGE_KEY]);
    if (
      order &&
      (order.revision > normalized.revision ||
        (order.revision === normalized.revision &&
          order.sourceId === normalized.sourceId &&
          order.sequence >= normalized.sequence))
    ) {
      return { applied: false, revision: order.revision };
    }

    const stored: StoredEditorDraft = {
      version: STORAGE_VERSION,
      sourceId: normalized.sourceId,
      sequence: normalized.sequence,
      revision: normalized.revision,
      text: normalized.draft?.text ?? '',
      ...(normalized.draft?.corrections === undefined
        ? {}
        : {
            corrections: normalized.draft.corrections.map((correction) => ({ ...correction })),
            configKey: normalized.draft.configKey,
          }),
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: stored });
    return { applied: true, revision: normalized.revision };
  });
  saveQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

/** Attaches a correction result only if the saved text has not changed. */
export function saveEditorDraftResult(update: EditorDraftResultUpdate): Promise<boolean> {
  if (!Number.isSafeInteger(update.baseRevision) || update.baseRevision < 0) {
    return Promise.reject(new Error('The editor draft base revision is invalid.'));
  }
  const draft = normalizeDraft(
    { text: update.text, corrections: update.corrections, configKey: update.configKey },
    false,
  );
  if (!draft?.corrections) return Promise.reject(new Error('The editor draft result is invalid.'));

  const operation = saveQueue.then(async () => {
    const current = await chrome.storage.local.get(STORAGE_KEY);
    const stored = current[STORAGE_KEY];
    if (
      !isRecord(stored) ||
      stored.version !== STORAGE_VERSION ||
      stored.revision !== update.baseRevision ||
      stored.text !== update.text
    ) {
      return false;
    }
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        ...stored,
        corrections: draft.corrections?.map((correction) => ({ ...correction })),
        configKey: draft.configKey,
      },
    });
    return true;
  });
  saveQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

/** Clears saved text while retaining sequencing metadata against stale writes. */
export function clearEditorDraft(
  sourceId: string,
  sequence: number,
  revision: number,
): Promise<EditorDraftWriteResult> {
  return saveEditorDraft({ sourceId, sequence, revision, draft: null });
}
