// One-shot handoff of selected text from the context menu (service worker) to
// the popup, so right-clicking non-editable text can open the popup pre-filled
// and show the correction there. Uses chrome.storage.session: it survives the
// popup opening, is never written to disk, and is cleared once consumed.

const PENDING_CORRECTION_KEY = 'pendingCorrection';

// Ignore a handoff the popup didn't pick up promptly — e.g. openPopup() failed,
// or the popup was dismissed before it could consume it. This prevents a stale
// selection from hijacking the next unrelated popup open.
const MAX_AGE_MS = 15000;

export interface PendingCorrection {
  text: string;
  ts: number;
}

/**
 * Stashes text for the popup to pick up when it opens. Returns the write promise
 * but is safe to call without awaiting — important because it must run
 * synchronously before `chrome.action.openPopup()`, which requires the calling
 * user gesture to still be active.
 */
export function setPendingCorrection(text: string): Promise<void> {
  const pending: PendingCorrection = { text, ts: Date.now() };
  return chrome.storage.session.set({ [PENDING_CORRECTION_KEY]: pending });
}

/** Discards any pending correction (e.g. when the popup couldn't be opened). */
export function clearPendingCorrection(): Promise<void> {
  return chrome.storage.session.remove(PENDING_CORRECTION_KEY);
}

/**
 * Reads and clears any pending correction. Returns null when there is none, or
 * when the stashed entry is too old to still be relevant (it is cleared either
 * way, so a stale handoff never lingers).
 */
export async function takePendingCorrection(): Promise<PendingCorrection | null> {
  const stored = await chrome.storage.session.get(PENDING_CORRECTION_KEY);
  const pending = stored[PENDING_CORRECTION_KEY] as PendingCorrection | undefined;
  if (pending) await chrome.storage.session.remove(PENDING_CORRECTION_KEY).catch(() => undefined);
  if (!pending || typeof pending.text !== 'string' || typeof pending.ts !== 'number') return null;
  if (Date.now() - pending.ts > MAX_AGE_MS) return null;
  return pending;
}
