// Detects when the extension context has been invalidated. This happens when the
// extension is reloaded, updated, or removed while a page is still open: the
// already-injected content script keeps running but can no longer reach the
// extension, so every chrome.* call throws "Extension context invalidated".
//
// We detect this once and run registered teardown handlers so the content script
// stops its timers, observers, and debounced checks instead of spamming errors.

import { createLogger } from '../shared/logger';

const log = createLogger('content');

let invalidated = false;
const teardownHandlers = new Set<() => void>();

function runSafely(handler: () => void): void {
  try {
    handler();
  } catch {
    /* ignore — teardown must never throw */
  }
}

/** Whether the extension context is still usable for chrome.* messaging. */
export function extensionContextValid(): boolean {
  if (invalidated) return false;
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/** Whether a thrown/rejected error indicates the extension context is gone. */
export function isContextInvalidationError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('context invalidated') || message.includes('extension context');
}

/**
 * Registers a teardown callback that runs once, when the context is invalidated.
 * If the context is already invalidated, the callback runs immediately.
 */
export function onContextInvalidated(handler: () => void): void {
  if (invalidated) {
    runSafely(handler);
    return;
  }
  teardownHandlers.add(handler);
}

/** Marks the context invalid (idempotent) and runs all teardown handlers once. */
export function invalidateContext(): void {
  if (invalidated) return;
  invalidated = true;
  log.info('Extension context invalidated; shutting down content script.');
  const handlers = [...teardownHandlers];
  teardownHandlers.clear();
  for (const handler of handlers) runSafely(handler);
}
