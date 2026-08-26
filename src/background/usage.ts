const STORAGE_KEY = 'runnerUsage';
const WRITE_INTERVAL_MS = 60 * 60 * 1000;

interface RunnerUsage {
  lastUsedAt: number;
}

let lastKnownUse: number | null | undefined;
let queue: Promise<void> = Promise.resolve();

function timestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

async function readUsage(): Promise<number | null> {
  if (lastKnownUse !== undefined) return lastKnownUse;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<RunnerUsage> | undefined;
  lastKnownUse = timestamp(value?.lastUsedAt);
  return lastKnownUse;
}

/** Last persisted real grammar-check activity, or null for a new/unused install. */
export function lastGrammarActivity(): Promise<number | null> {
  return queue.then(readUsage);
}

/**
 * Records real correction activity without writing to disk for every keystroke.
 * At most one write per hour is enough for the seven-day startup policy.
 */
export function recordGrammarActivity(now = Date.now()): Promise<void> {
  const operation = queue.then(async () => {
    const previous = await readUsage();
    if (previous !== null && now - previous < WRITE_INTERVAL_MS) return;
    lastKnownUse = now;
    await chrome.storage.local.set({
      [STORAGE_KEY]: { lastUsedAt: now } satisfies RunnerUsage,
    });
  });
  queue = operation.catch(() => undefined);
  return operation;
}
