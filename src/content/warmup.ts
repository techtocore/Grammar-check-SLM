import { sendToBackground } from '../shared/messages';
import { invalidateContext, isContextInvalidationError } from './lifecycle';

const WARMUP_COOLDOWN_MS = 60_000;

let lastRequestedAt = Number.NEGATIVE_INFINITY;
let inFlight = false;

/**
 * Hints that editing is imminent. Background warmup is cache-only, so this can
 * reduce first-check latency without ever initiating a model download.
 */
export function requestCachedWarmup(now = Date.now()): void {
  if (inFlight || now - lastRequestedAt < WARMUP_COOLDOWN_MS) return;
  lastRequestedAt = now;
  inFlight = true;
  void sendToBackground({ type: 'warmup', target: 'background' })
    .catch((error: unknown) => {
      if (isContextInvalidationError(error)) invalidateContext();
    })
    .finally(() => {
      inFlight = false;
    });
}
