import { createLogger } from '../shared/logger';

const log = createLogger('offscreen-mgr');
const OFFSCREEN_PATH = 'offscreen.html';

let lifecycle: Promise<unknown> = Promise.resolve();

function runLifecycle<T>(task: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(task, task);
  lifecycle = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  return contexts.length > 0;
}

/** Whether the offscreen model runner document currently exists. */
export function offscreenExists(): Promise<boolean> {
  return hasOffscreenDocument();
}

/** Ensures exactly one offscreen document exists to host the model runner. */
export async function ensureOffscreen(): Promise<void> {
  return runLifecycle(async () => {
    if (await hasOffscreenDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          'Runs a local small language model (WebGPU/WASM) for on-device grammar checking.',
      });
    } catch (error) {
      // Chrome rejects when another caller won the race. Swallow only that
      // known-good outcome; otherwise preserve the actionable creation error.
      if (await hasOffscreenDocument().catch(() => false)) {
        log.warn('createDocument reported an error after another caller created it.', error);
        return;
      }
      throw error;
    }
  });
}

/** Closes the model runner after any in-progress creation finishes. */
export function closeOffscreen(): Promise<void> {
  return runLifecycle(async () => {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  });
}
