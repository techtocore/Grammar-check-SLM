import { closeOffscreen, ensureOffscreen, offscreenExists } from './offscreen-manager';
import {
  isAuthorizedBackgroundMessage,
  isBackgroundMessage,
  isOffscreenSender,
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
  const response = await sendToOffscreen<{ ok: boolean; error?: string }>({
    type: 'config',
    target: 'offscreen',
    config,
  });
  if (!response.ok) throw new Error(response.error ?? 'Could not configure the model runner.');
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
    lastStatus = { state: 'idle', progress: 0, modelId: '', device: 'unknown' };
    return lastStatus;
  }
  try {
    const status = await sendToOffscreen<ModelStatus>({ type: 'status', target: 'offscreen' });
    lastStatus = status;
    return status;
  } catch {
    return lastStatus ?? { state: 'idle', progress: 0, modelId: '', device: 'unknown' };
  }
}

const RUNNER_SETTING_KEYS: ReadonlySet<keyof Settings> = new Set([
  'backend',
  'model',
  'device',
  'language',
]);

function affectsRunner(patch: Partial<Settings>): boolean {
  return Object.keys(patch).some((key) => RUNNER_SETTING_KEYS.has(key as keyof Settings));
}

async function syncRunnerAfterSettings(
  settings: Settings,
  patch: Partial<Settings>,
): Promise<void> {
  if (!settings.enabled) {
    await closeOffscreen().catch((error: unknown) =>
      log.warn('Could not close the offscreen model after disabling.', error),
    );
    lastStatus = { state: 'disabled', progress: 0, modelId: '', device: 'unknown' };
    return;
  }

  if (patch.enabled === true) {
    lastStatus = { state: 'idle', progress: 0, modelId: '', device: 'unknown' };
    return;
  }

  if (affectsRunner(patch)) {
    // Release all old WASM/GPU memory, but do not recreate or warm the new model
    // until the user actually requests a correction.
    await closeOffscreen().catch((error: unknown) =>
      log.warn('Could not close the model runner after reconfiguration.', error),
    );
    lastStatus = { state: 'idle', progress: 0, modelId: '', device: 'unknown' };
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
  const activeModel = settings.model === 'auto' ? 'qwen3-0.6b' : settings.model;
  return MODEL_PRESETS.map((preset) => ({
    id: preset.id,
    modelId: preset.modelId,
    label: preset.label,
    description: preset.description,
    approxDownloadMB: preset.approxDownloadMB,
    requiresWebGPU: preset.requiresWebGPU ?? false,
    cached: cached[preset.modelId] ?? false,
    active: localActive && activeModel === preset.id,
  }));
}

async function handleModelsDownload(modelId: string): Promise<{ ok: boolean }> {
  if (!MODEL_PRESETS.some((preset) => preset.modelId === modelId)) return { ok: false };
  const settings = await loadSettings();
  await ensureOffscreen();
  // The offscreen document acknowledges immediately and reports progress via broadcasts.
  await sendToOffscreen({
    type: 'download',
    target: 'offscreen',
    modelId,
    device: settings.device,
  });
  return { ok: true };
}

async function handleModelsDelete(modelId: string): Promise<{ ok: boolean; deleted: number }> {
  if (!MODEL_PRESETS.some((preset) => preset.modelId === modelId)) {
    return { ok: false, deleted: 0 };
  }
  const deleted = await deleteModelCache(modelId);
  return { ok: true, deleted };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isStatusBroadcast(message)) {
    if (!isOffscreenSender(sender, chrome.runtime.id)) return undefined;
    lastStatus = message.status;
    return undefined;
  }
  if (!isBackgroundMessage(message)) return undefined;
  if (!isAuthorizedBackgroundMessage(message, sender, chrome.runtime.id)) {
    log.warn(`Rejected unauthorized ${message.type} message.`);
    return undefined;
  }

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
      // Sender metadata is supplied by Chrome and cannot be spoofed by a page.
      // Opaque about:blank/srcdoc frames inherit the top tab's governing origin.
      const origin = originOf(sender.url) ?? originOf(sender.tab?.url);
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
          await syncRunnerAfterSettings(settings, message.patch);
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

chrome.runtime.onInstalled.addListener(() => {
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
});

/** Sends a message to a page's content script, ignoring "no receiver" errors. */
function messageTab(tabId: number, message: ContentMessage, frameId?: number): void {
  const options = frameId !== undefined ? { frameId } : {};
  chrome.tabs.sendMessage(tabId, message, options).catch(() => undefined);
}

/** Corrects the selected text and asks the content script to replace/copy it. */
async function correctSelection(tabId: number, text: string, frameId?: number): Promise<void> {
  const requestId = newRequestId();
  messageTab(
    tabId,
    { type: 'gc-correcting', target: 'content', requestId, original: text },
    frameId,
  );
  try {
    const result = await handleCorrect(text, requestId);
    const corrected = applyCorrections(text, result.corrections);
    messageTab(
      tabId,
      {
        type: 'gc-correct-result',
        target: 'content',
        requestId,
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
        requestId,
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
    })();
  }
});

log.info('Service worker started.');
