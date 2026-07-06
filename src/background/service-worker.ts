import { ensureOffscreen, offscreenExists } from './offscreen-manager';
import {
  isBackgroundMessage,
  isStatusBroadcast,
  sendToOffscreen,
  type CheckResult,
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
import { createLogger } from '../shared/logger';

const log = createLogger('background');

const CONTEXT_MENU_TOGGLE = 'gcslm-toggle-site';

let lastStatus: ModelStatus | null = null;
let currentConfigKey = '';

function runnerConfig(settings: Settings): RunnerConfig {
  return { model: settings.model, device: settings.device, language: settings.language };
}

/** Ensures the offscreen runner exists and has the current configuration. */
async function ensureConfigured(settings: Settings): Promise<void> {
  const existedBefore = await offscreenExists();
  await ensureOffscreen();
  // A freshly created offscreen document has no config yet, even if the service
  // worker still believes it delivered one earlier.
  if (!existedBefore) currentConfigKey = '';
  const config = runnerConfig(settings);
  const key = JSON.stringify(config);
  if (key !== currentConfigKey) {
    await sendToOffscreen({ type: 'config', target: 'offscreen', config });
    currentConfigKey = key;
  }
}

async function handleCheck(
  text: string,
  senderUrl: string | undefined,
  requestId: string,
): Promise<CheckResult> {
  const settings = await loadSettings();
  if (!isSiteEnabled(settings, originOf(senderUrl))) {
    return { requestId, sourceText: text, corrections: [] };
  }
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
  currentConfigKey = '';
  if (await offscreenExists()) {
    await ensureConfigured(await loadSettings());
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
  return MODEL_PRESETS.map((preset) => ({
    id: preset.id,
    modelId: preset.modelId,
    label: preset.label,
    description: preset.description,
    approxDownloadMB: preset.approxDownloadMB,
    requiresWebGPU: preset.requiresWebGPU ?? false,
    cached: cached[preset.modelId] ?? false,
    active: settings.model === preset.id,
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
      // `sender.url` (the frame URL) is always available; `sender.tab.url` can be
      // undefined without the "tabs" permission.
      handleCheck(text, sender.url ?? sender.tab?.url, requestId)
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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_TOGGLE) return;
  const origin = originOf(tab?.url);
  if (!origin) return;

  void (async () => {
    const settings = await loadSettings();
    const enabled = isSiteEnabled(settings, origin);
    await saveSettings(setSiteEnabled(settings, origin, !enabled));
    await reconfigureIfRunning();
  })();
});

log.info('Service worker started.');
