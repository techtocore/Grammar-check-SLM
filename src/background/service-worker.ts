import { ensureOffscreen, offscreenExists } from './offscreen-manager';
import {
  isBackgroundMessage,
  isStatusBroadcast,
  newRequestId,
  sendToOffscreen,
  type CheckResult,
  type ContentMessage,
  type ModelInfo,
  type ModelStatus,
  type RunnerConfig,
} from '../shared/messages';
import {
  isSiteEnabled,
  loadSettings,
  originOf,
  saveSettings,
  setSiteEnabled,
  type Settings,
} from '../shared/settings';
import { MODEL_PRESETS } from '../shared/models';
import { deleteModelCache, listCachedModels } from '../shared/model-cache';
import { setPendingCorrection, clearPendingCorrection } from '../shared/pending';
import { applyCorrections } from '../core/corrections';
import { createLogger } from '../shared/logger';

const log = createLogger('background');

const CONTEXT_MENU_TOGGLE = 'gcslm-toggle-site';
const CONTEXT_MENU_CORRECT = 'gcslm-correct-selection';

let lastStatus: ModelStatus | null = null;
let currentModelKey = '';

function runnerConfig(settings: Settings): RunnerConfig {
  return {
    backend: settings.backend,
    model: settings.model,
    device: settings.device,
    language: settings.language,
  };
}

/**
 * Ensures the offscreen runner exists and is configured. Config is always
 * (re)sent — `setConfig` is a no-op on the offscreen when nothing changed — so a
 * freshly (re)created offscreen document can never end up without a config
 * (which would make loading fail with "not configured" and leave status idle).
 */
async function ensureConfigured(settings: Settings): Promise<void> {
  await ensureOffscreen();
  const config = runnerConfig(settings);
  await sendToOffscreen({ type: 'config', target: 'offscreen', config });
  currentModelKey = `${config.backend}|${config.model}|${config.device}`;
}

async function handleCheck(
  text: string,
  origin: string | null,
  requestId: string,
): Promise<CheckResult> {
  const settings = await loadSettings();
  if (!isSiteEnabled(settings, origin)) {
    return { requestId, sourceText: text, corrections: [] };
  }
  await ensureConfigured(settings);
  return sendToOffscreen<CheckResult>({ type: 'check', target: 'offscreen', requestId, text });
}

/**
 * Corrects arbitrary text for the popup Editor — always allowed (not gated by
 * the per-site rules that apply to on-page checking).
 */
async function handleCorrect(text: string, requestId: string): Promise<CheckResult> {
  const settings = await loadSettings();
  await ensureConfigured(settings);
  return sendToOffscreen<CheckResult>({ type: 'check', target: 'offscreen', requestId, text });
}

async function handleWarmup(): Promise<ModelStatus> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return { state: 'disabled', progress: 0, modelId: '', device: 'unknown' };
  }
  await ensureConfigured(settings);
  const status = await sendToOffscreen<ModelStatus>({ type: 'warmup', target: 'offscreen' });
  lastStatus = status;
  return status;
}

async function handleStatus(): Promise<ModelStatus> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return { state: 'disabled', progress: 0, modelId: '', device: 'unknown' };
  }
  if (!(await offscreenExists())) {
    return lastStatus ?? { state: 'idle', progress: 0, modelId: '', device: 'unknown' };
  }
  try {
    const status = await sendToOffscreen<ModelStatus>({ type: 'status', target: 'offscreen' });
    lastStatus = status;
    return status;
  } catch {
    return lastStatus ?? { state: 'idle', progress: 0, modelId: '', device: 'unknown' };
  }
}

async function reconfigureIfRunning(): Promise<void> {
  const settings = await loadSettings();
  const config = runnerConfig(settings);
  const newModelKey = `${config.backend}|${config.model}|${config.device}`;

  if (!(await offscreenExists())) {
    currentModelKey = '';
    return;
  }

  if (currentModelKey !== '' && newModelKey !== currentModelKey) {
    // Model or backend changed: fully tear down the offscreen document so ALL of
    // the previous model's memory (WASM heap, GPU buffers, ArrayBuffers) is
    // reclaimed, then recreate it fresh. Reusing the document leaks memory across
    // switches and eventually prevents any model from loading.
    await chrome.offscreen.closeDocument().catch(() => undefined);
    currentModelKey = '';
    if (settings.enabled) {
      await ensureConfigured(settings);
      void sendToOffscreen({ type: 'warmup', target: 'offscreen' }).catch(() => undefined);
    }
  } else {
    // Same model/backend (or unknown): update configuration in place.
    await ensureConfigured(settings);
  }
}

async function handleRetry(): Promise<ModelStatus> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return { state: 'disabled', progress: 0, modelId: '', device: 'unknown' };
  }
  await ensureConfigured(settings);
  const status = await sendToOffscreen<ModelStatus>({ type: 'reload', target: 'offscreen' });
  lastStatus = status;
  return status;
}

async function handleModelsList(): Promise<ModelInfo[]> {
  const settings = await loadSettings();
  const cached = await listCachedModels(MODEL_PRESETS.map((p) => p.modelId));
  const localActive = settings.backend !== 'prompt';
  return MODEL_PRESETS.map((preset) => ({
    id: preset.id,
    modelId: preset.modelId,
    label: preset.label,
    description: preset.description,
    approxDownloadMB: preset.approxDownloadMB,
    requiresWebGPU: preset.requiresWebGPU ?? false,
    cached: cached[preset.modelId] ?? false,
    active: localActive && settings.model === preset.id,
  }));
}

async function handleModelsDownload(modelId: string): Promise<{ ok: boolean }> {
  await ensureOffscreen();
  // The offscreen document acknowledges immediately and reports progress via broadcasts.
  await sendToOffscreen({ type: 'download', target: 'offscreen', modelId });
  return { ok: true };
}

async function handleModelsDelete(modelId: string): Promise<{ ok: boolean; deleted: number }> {
  const deleted = await deleteModelCache(modelId);
  return { ok: true, deleted };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isStatusBroadcast(message)) {
    lastStatus = message.status;
    return undefined;
  }
  if (!isBackgroundMessage(message)) return undefined;

  switch (message.type) {
    case 'status': {
      handleStatus()
        .then(sendResponse)
        .catch(() => sendResponse(null));
      return true;
    }
    case 'warmup': {
      handleWarmup()
        .then(sendResponse)
        .catch((error: unknown) => {
          log.error('Warmup failed.', error);
          sendResponse({ state: 'error', progress: 0, modelId: '', device: 'unknown' });
        });
      return true;
    }
    case 'retry': {
      handleRetry()
        .then(sendResponse)
        .catch((error: unknown) => {
          log.error('Retry failed.', error);
          sendResponse({ state: 'error', progress: 0, modelId: '', device: 'unknown' });
        });
      return true;
    }
    case 'models:list': {
      handleModelsList()
        .then(sendResponse)
        .catch(() => sendResponse([]));
      return true;
    }
    case 'models:download': {
      handleModelsDownload(message.modelId)
        .then(sendResponse)
        .catch((error: unknown) => {
          log.error('Model download failed.', error);
          sendResponse({ ok: false });
        });
      return true;
    }
    case 'models:delete': {
      handleModelsDelete(message.modelId)
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, deleted: 0 }));
      return true;
    }
    case 'check': {
      const { text, requestId } = message;
      // The content script sends its effective governing origin (the top origin
      // for same-origin editor iframes with opaque about:blank/srcdoc URLs).
      // Fall back to the frame URL when it wasn't provided.
      const origin = message.origin ?? originOf(sender.url ?? sender.tab?.url);
      handleCheck(text, origin, requestId)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            requestId,
            sourceText: text,
            corrections: [],
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }
    case 'correct': {
      const { text, requestId } = message;
      handleCorrect(text, requestId)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            requestId,
            sourceText: text,
            corrections: [],
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }
    case 'settings:get': {
      loadSettings()
        .then(sendResponse)
        .catch(() => sendResponse(null));
      return true;
    }
    case 'settings:set': {
      saveSettings(message.patch)
        .then(async (settings) => {
          await reconfigureIfRunning();
          if (settings.enabled) {
            // Proactively (re)load the model so it becomes ready without the
            // user having to open the popup — covers enabling the extension
            // when no offscreen document exists yet.
            void handleWarmup().catch((error: unknown) =>
              log.warn('Warmup after settings change failed.', error),
            );
          }
          sendResponse(settings);
        })
        .catch(() => sendResponse(null));
      return true;
    }
    case 'site:enabled': {
      const { origin } = message;
      loadSettings()
        .then((settings) => sendResponse(isSiteEnabled(settings, origin)))
        .catch(() => sendResponse(false));
      return true;
    }
    default:
      return undefined;
  }
});

// ---- Context menu: quickly toggle checking on the current site ----

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create(
    {
      id: CONTEXT_MENU_CORRECT,
      title: 'Correct grammar of “%s”',
      contexts: ['selection'],
    },
    () => void chrome.runtime.lastError,
  );
  chrome.contextMenus.create(
    {
      id: CONTEXT_MENU_TOGGLE,
      title: 'Toggle Grammar Check on this site',
      contexts: ['action', 'editable'],
    },
    () => void chrome.runtime.lastError,
  );

  // Start downloading/preparing the active model right after install/update so
  // it is ready (and cached) before the user first types.
  if (details.reason === 'install' || details.reason === 'update') {
    void handleWarmup().catch((error: unknown) => log.warn('Initial model warmup failed.', error));
  }
});

/** Sends a message to a page's content script, ignoring "no receiver" errors. */
function messageTab(tabId: number, message: ContentMessage, frameId?: number): void {
  const options = frameId !== undefined ? { frameId } : {};
  chrome.tabs.sendMessage(tabId, message, options).catch(() => undefined);
}

/** Corrects the selected text and asks the content script to replace/copy it. */
async function correctSelection(tabId: number, text: string, frameId?: number): Promise<void> {
  messageTab(tabId, { type: 'gc-correcting', target: 'content' }, frameId);
  try {
    const result = await handleCorrect(text, newRequestId());
    const corrected = applyCorrections(text, result.corrections);
    messageTab(
      tabId,
      {
        type: 'gc-correct-result',
        target: 'content',
        corrected,
        original: text,
        error: result.error,
      },
      frameId,
    );
  } catch (error) {
    messageTab(
      tabId,
      {
        type: 'gc-correct-result',
        target: 'content',
        corrected: text,
        original: text,
        error: error instanceof Error ? error.message : String(error),
      },
      frameId,
    );
  }
}

/**
 * Opens the extension popup pre-filled with the selected text so the user can
 * see the correction there. Used for non-editable selections, where in-place
 * replacement isn't possible.
 *
 * The text handoff is fired synchronously (not awaited) so it happens while the
 * context-menu user gesture is still active — `chrome.action.openPopup()`
 * requires one. If the popup can't be opened, falls back to correcting the
 * selection on the page (copy-to-clipboard).
 */
async function openPopupWithSelection(
  text: string,
  tabId: number | undefined,
  frameId?: number,
): Promise<void> {
  if (typeof chrome.action.openPopup === 'function') {
    void setPendingCorrection(text).catch(() => undefined);
    try {
      await chrome.action.openPopup();
      return;
    } catch (error) {
      log.warn('Could not open the popup; correcting on the page instead.', error);
      // Don't leave the handoff behind to hijack the next popup open.
      await clearPendingCorrection().catch(() => undefined);
    }
  }
  if (tabId !== undefined) void correctSelection(tabId, text, frameId);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_CORRECT) {
    // Keep the raw selection (don't trim) so applyCorrections preserves the
    // original surrounding whitespace when the result replaces the selection.
    const text = info.selectionText;
    if (!text || !text.trim()) return;
    const tabId = tab?.id;
    // Editable fields (inputs, textareas, contenteditable) get corrected in
    // place; non-editable text opens the popup with the correction instead.
    if (info.editable && tabId !== undefined) {
      void correctSelection(tabId, text, info.frameId);
    } else {
      void openPopupWithSelection(text, tabId, info.frameId);
    }
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_TOGGLE) {
    const origin = originOf(tab?.url);
    if (!origin) return;
    void (async () => {
      const settings = await loadSettings();
      const enabled = isSiteEnabled(settings, origin);
      await saveSettings(setSiteEnabled(settings, origin, !enabled));
      await reconfigureIfRunning();
    })();
  }
});

log.info('Service worker started.');
