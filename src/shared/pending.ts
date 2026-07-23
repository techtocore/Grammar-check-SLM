// One-shot handoff of selected text from the context menu (service worker) to
// the popup, so right-clicking non-editable text can open the popup pre-filled
// and show the correction there. Uses chrome.storage.session: it survives the
// popup opening, is never written to disk, and is cleared once consumed.

const PENDING_CORRECTION_PREFIX = 'pendingCorrection:';

// Ignore a handoff the popup didn't pick up promptly — e.g. openPopup() failed,
// or the popup was dismissed before it could consume it. This prevents a stale
// selection from hijacking the next unrelated popup open.
const MAX_AGE_MS = 15000;
let lastTimestamp = 0;
let pendingQueue: Promise<void> = Promise.resolve();

export interface PendingCorrection {
  text: string;
  ts: number;
}

export interface PendingCorrectionHandle {
  key: string;
  stored: Promise<void>;
}

function queuePending<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingQueue.then(operation);
  pendingQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function nextTimestamp(): number {
  const now = Date.now();
  lastTimestamp = Math.max(now, lastTimestamp + 1);
  return lastTimestamp;
}

/**
 * Stashes text for the popup to pick up when it opens. The handle is created
 * synchronously so `chrome.action.openPopup()` can still run in the user gesture.
 */
export function setPendingCorrection(text: string): PendingCorrectionHandle {
  const pending: PendingCorrection = { text, ts: nextTimestamp() };
  const key = `${PENDING_CORRECTION_PREFIX}${pending.ts.toString(36)}-${crypto.randomUUID()}`;
  return {
    key,
    stored: queuePending(() => chrome.storage.session.set({ [key]: pending })),
  };
}

/** Discards one exact handoff (e.g. when its popup could not be opened). */
export function clearPendingCorrection(key: string): Promise<void> {
  if (!key.startsWith(PENDING_CORRECTION_PREFIX)) return Promise.resolve();
  return queuePending(() => chrome.storage.session.remove(key));
}

/**
 * Reads and clears any pending correction. Returns null when there is none, or
 * when the stashed entry is too old to still be relevant (it is cleared either
 * way, so a stale handoff never lingers).
 */
export async function takePendingCorrection(): Promise<PendingCorrection | null> {
  return queuePending(async () => {
    const stored = await chrome.storage.session.get(null);
    const entries = Object.entries(stored).filter(([key]) =>
      key.startsWith(PENDING_CORRECTION_PREFIX),
    );
    if (entries.length === 0) return null;

    const now = Date.now();
    const valid = entries
      .map(([, value]) => value as Partial<PendingCorrection> | undefined)
      .filter(
        (pending): pending is PendingCorrection =>
          typeof pending?.text === 'string' &&
          typeof pending.ts === 'number' &&
          Number.isFinite(pending.ts) &&
          Math.abs(now - pending.ts) <= MAX_AGE_MS,
      )
      .sort((a, b) => b.ts - a.ts);

    // This snapshot is serialized against writers. Remove every older handoff so
    // one quick selection can never hijack a later, unrelated popup opening.
    await chrome.storage.session.remove(entries.map(([key]) => key));
    return valid[0] ?? null;
  });
}
