import { createLogger } from '../shared/logger';

const log = createLogger('offscreen-mgr');
const OFFSCREEN_PATH = 'offscreen.html';

let creating: Promise<void> | null = null;

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
  if (await hasOffscreenDocument()) return;

  if (creating) {
    await creating;
    return;
  }

  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        'Runs a local small language model (WebGPU/WASM) for on-device grammar checking.',
    })
    .catch((error: unknown) => {
      // A concurrent caller may have created it first; that is fine.
      log.warn('createDocument reported an error (may already exist).', error);
    })
    .finally(() => {
      creating = null;
    });

  await creating;
}
