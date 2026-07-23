import { closeOffscreen, ensureOffscreen, offscreenExists } from './offscreen-manager';
import {
  isAuthorizedBackgroundMessage,
  isBackgroundMessage,
  isOffscreenSender,
  isStatusBroadcast,
  newRequestId,
  sendToOffscreen,
  type CheckResult,
  type ModelDownloadStatus,
  type ContentMessage,
  type ModelInfo,
  type ModelStatus,
  type RunnerConfig,
} from '../shared/messages';
import {
  isSiteEnabled,
  loadSettings,
  originOf,
  runnerSettingsKey,
  saveSettings,
  setSiteEnabled,
  type Settings,
} from '../shared/settings';
import { MODEL_PRESETS, resolvePreset } from '../shared/models';
import { listModelCacheInfo } from '../shared/model-cache';
import {
  clearPendingCorrection,
  setPendingCorrection,
  takePendingCorrection,
} from '../shared/pending';
import {
  clearEditorDraft,
  loadEditorDraftState,
  saveEditorDraft,
  saveEditorDraftResult,
} from '../shared/editor-draft';
import { applyCorrections } from '../core/corrections';
import { createLogger } from '../shared/logger';
import { handleFirstRunInstall } from './first-run';
import { activateExistingTabs } from './tab-activation';
import { assertSetupVerified, SETUP_PROBE } from './setup-verification';

const log = createLogger('background');

const CONTEXT_MENU_TOGGLE = 'gcslm-toggle-site';
const CONTEXT_MENU_CORRECT = 'gcslm-correct-selection';

let lastStatus: ModelStatus | null = null;
let settingsGeneration = 0;
let settingsMutation: Promise<void> = Promise.resolve();

function runnerConfig(settings: Settings): RunnerConfig {
  return {
    backend: settings.backend,
    model: settings.model,
    device: settings.device,
    language: settings.language,
  };
}

function runnerConfigKey(settings: Settings): string {
  return runnerSettingsKey(settings);
}

function checkConfigKey(settings: Settings, origin: string | null): string {
  return JSON.stringify({
    runner: runnerSettingsKey(settings),
    siteEnabled: isSiteEnabled(settings, origin),
  });
}

function trackSettingsMutation<T>(operation: Promise<T>): Promise<T> {
  settingsGeneration++;
  settingsMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function changedConfigurationResult(
  text: string,
  requestId: string,
  configKey: string,
): CheckResult {
  return {
    requestId,
    sourceText: text,
    corrections: [],
    nextOffset: 0,
    complete: true,
    configKey,
    configurationChanged: true,
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
  startOffset = 0,
  expectedConfigKey?: string,
): Promise<CheckResult> {
  await settingsMutation;
  const generation = settingsGeneration;
  const settings = await loadSettings();
  const configKey = checkConfigKey(settings, origin);
  if (expectedConfigKey && expectedConfigKey !== configKey) {
    return changedConfigurationResult(text, requestId, configKey);
  }
  if (!isSiteEnabled(settings, origin)) {
    return {
      requestId,
      sourceText: text,
      corrections: [],
      nextOffset: text.length,
      complete: true,
      configKey,
    };
  }
  await ensureConfigured(settings);
  await settingsMutation;
  const latestConfigKey = checkConfigKey(await loadSettings(), origin);
  if (generation !== settingsGeneration || latestConfigKey !== configKey) {
    return changedConfigurationResult(text, requestId, latestConfigKey);
  }
  const result = await sendToOffscreen<CheckResult>({
    type: 'check',
    target: 'offscreen',
    requestId,
    text,
    startOffset,
  });
  await settingsMutation;
  const completedConfigKey = checkConfigKey(await loadSettings(), origin);
  if (generation !== settingsGeneration || completedConfigKey !== configKey) {
    return changedConfigurationResult(text, requestId, completedConfigKey);
  }
  return { ...result, configKey };
}

/**
 * Corrects arbitrary text for the popup Editor — always allowed (not gated by
 * the per-site rules that apply to on-page checking).
 */
async function handleCorrect(
  text: string,
  requestId: string,
  startOffset = 0,
  expectedConfigKey?: string,
): Promise<CheckResult> {
  await settingsMutation;
  const generation = settingsGeneration;
  const settings = await loadSettings();
  const configKey = runnerConfigKey(settings);
  if (expectedConfigKey && expectedConfigKey !== configKey) {
    return changedConfigurationResult(text, requestId, configKey);
  }
  await ensureConfigured(settings);
  await settingsMutation;
  const latestConfigKey = runnerConfigKey(await loadSettings());
  if (generation !== settingsGeneration || latestConfigKey !== configKey) {
    return changedConfigurationResult(text, requestId, latestConfigKey);
  }
  const result = await sendToOffscreen<CheckResult>({
    type: 'check',
    target: 'offscreen',
    requestId,
    text,
    startOffset,
  });
  await settingsMutation;
  const completedConfigKey = runnerConfigKey(await loadSettings());
  if (generation !== settingsGeneration || completedConfigKey !== configKey) {
    return changedConfigurationResult(text, requestId, completedConfigKey);
  }
  return { ...result, configKey };
}

async function handleCorrectAll(text: string, requestId: string): Promise<CheckResult> {
  const corrections: CheckResult['corrections'] = [];
  let startOffset = 0;
  let configKey: string | undefined;
  let configRestarts = 0;
  while (true) {
    const result = await handleCorrect(text, requestId, startOffset, configKey);
    if (result.configurationChanged) {
      if (++configRestarts > 3) throw new Error('Grammar-check settings kept changing.');
      corrections.length = 0;
      startOffset = 0;
      configKey = result.configKey;
      continue;
    }
    configKey = result.configKey ?? configKey;
    corrections.push(...result.corrections);
    if (result.error || result.complete) return { ...result, corrections };
    if (result.nextOffset <= startOffset) {
      throw new Error('The grammar checker did not advance through the text.');
    }
    startOffset = result.nextOffset;
  }
}

async function handleSetupVerify(): Promise<{
  ok: boolean;
  status: ModelStatus;
  error?: string;
}> {
  const result = await handleCorrectAll(SETUP_PROBE, newRequestId());
  const status = await handleStatus();
  assertSetupVerified(result, status);
  return { ok: true, status };
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
    await suspendExistingRunner();
    lastStatus = { state: 'disabled', progress: 0, modelId: '', device: 'unknown' };
    return;
  }

  if (patch.enabled === true) {
    lastStatus = { state: 'idle', progress: 0, modelId: '', device: 'unknown' };
    return;
  }

  if (affectsRunner(patch)) {
    // Queue disposal behind active inference/download work. Closing the whole
    // document here could destroy a newly accepted first-run download.
    await suspendExistingRunner();
    lastStatus = { state: 'idle', progress: 0, modelId: '', device: 'unknown' };
  }
}

async function suspendExistingRunner(): Promise<void> {
  const exists = await offscreenExists().catch(() => false);
  if (!exists) return;
  try {
    const response = await sendToOffscreen<{ ok: boolean }>({
      type: 'suspend',
      target: 'offscreen',
    });
    if (!response.ok) throw new Error('The model runner did not accept suspension.');
  } catch (error) {
    log.warn('Could not suspend the model runner.', error);
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
  const cachePreference = await cachePreferenceFor(settings.device);
  const [cacheInfo, downloadStatuses] = await Promise.all([
    listModelCacheInfo(
      MODEL_PRESETS.map((preset) => preset.modelId),
      cachePreference,
    ),
    handleDownloadStatuses(),
  ]);
  const downloadsByModel = new Map(downloadStatuses.map((status) => [status.modelId, status]));
  const localActive = settings.backend !== 'prompt';
  const activeModel = resolvePreset(settings.model, cachePreference !== 'wasm').id;
  return MODEL_PRESETS.map((preset) => ({
    id: preset.id,
    modelId: preset.modelId,
    label: preset.label,
    description: preset.description,
    approxDownloadMB: preset.approxDownloadMB,
    requiresWebGPU: preset.requiresWebGPU ?? false,
    cached: cacheInfo[preset.modelId]?.cached ?? false,
    partial: cacheInfo[preset.modelId]?.partial ?? false,
    active: localActive && activeModel === preset.id,
    download: downloadsByModel.get(preset.modelId),
  }));
}

async function cachePreferenceFor(preference: Settings['device']): Promise<Settings['device']> {
  if (preference !== 'auto') return preference;
  await ensureOffscreen();
  const capability = await sendToOffscreen<{ hasWebGPU: boolean }>({
    type: 'device:detect',
    target: 'offscreen',
  });
  return capability.hasWebGPU ? 'auto' : 'wasm';
}

async function handleDownloadStatuses(): Promise<ModelDownloadStatus[]> {
  const exists = await offscreenExists().catch(() => false);
  if (!exists) return [];
  return sendToOffscreen<ModelDownloadStatus[]>({
    type: 'downloads:status',
    target: 'offscreen',
  });
}

async function handleModelsDownload(
  modelId: string,
  purpose?: 'onboarding',
): Promise<{ ok: boolean; error?: string }> {
  if (!MODEL_PRESETS.some((preset) => preset.modelId === modelId)) {
    return { ok: false, error: 'Unknown local model.' };
  }
  const settings = await loadSettings();
  await ensureOffscreen();
  // The offscreen document acknowledges immediately and reports progress via broadcasts.
  const response = await sendToOffscreen<{ ok: boolean; error?: string }>({
    type: 'download',
    target: 'offscreen',
    modelId,
    device: settings.device,
    purpose,
  });
  return response.ok
    ? { ok: true }
    : { ok: false, error: response.error ?? 'The model download could not be started.' };
}

async function handleOnboardingSelect(
  modelId: string,
  cached: boolean,
): Promise<{ ok: boolean; reset: boolean; error?: string }> {
  if (!MODEL_PRESETS.some((preset) => preset.modelId === modelId)) {
    return { ok: false, reset: false, error: 'Unknown local model.' };
  }
  const settings = await loadSettings();
  await ensureOffscreen();
  const state = await sendToOffscreen<{
    hasMatchingRunning: boolean;
    hasObsoleteRunning: boolean;
    hasMatchingRunnerLoading: boolean;
    hasObsoleteRunnerLoading: boolean;
    clearedObsoleteStatus: boolean;
    error?: string;
  }>({
    type: 'onboarding:select',
    target: 'offscreen',
    modelId,
    device: settings.device,
  });
  if (state.error) return { ok: false, reset: false, error: state.error };
  const reset =
    state.hasObsoleteRunning ||
    state.hasObsoleteRunnerLoading ||
    state.clearedObsoleteStatus ||
    (cached && (state.hasMatchingRunning || state.hasMatchingRunnerLoading));
  if (reset) await closeOffscreen();
  return { ok: true, reset };
}

async function handleModelsDelete(
  modelId: string,
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  if (!MODEL_PRESETS.some((preset) => preset.modelId === modelId)) {
    return { ok: false, deleted: 0, error: 'Unknown local model.' };
  }
  await ensureOffscreen();
  return sendToOffscreen<{ ok: boolean; deleted: number; error?: string }>({
    type: 'download:delete',
    target: 'offscreen',
    modelId,
  });
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
      handleModelsDownload(message.modelId, message.purpose)
        .then(sendResponse)
        .catch((error: unknown) => {
          log.error('Model download failed.', error);
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }
    case 'models:onboarding:select': {
      handleOnboardingSelect(message.modelId, message.cached)
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            reset: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'models:delete': {
      handleModelsDelete(message.modelId)
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            deleted: 0,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'check': {
      const { text, requestId, startOffset, configKey } = message;
      // Sender metadata is supplied by Chrome and cannot be spoofed by a page.
      // Opaque about:blank/srcdoc frames inherit the top tab's governing origin.
      const origin = originOf(sender.url) ?? originOf(sender.tab?.url);
      handleCheck(text, origin, requestId, startOffset, configKey)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            requestId,
            sourceText: text,
            corrections: [],
            nextOffset: startOffset ?? 0,
            complete: true,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }
    case 'correct': {
      const { text, requestId, startOffset, configKey } = message;
      handleCorrect(text, requestId, startOffset, configKey)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            requestId,
            sourceText: text,
            corrections: [],
            nextOffset: startOffset ?? 0,
            complete: true,
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
      const operation = trackSettingsMutation(
        saveSettings(message.patch).then(async (settings) => {
          await syncRunnerAfterSettings(settings, message.patch);
          return settings;
        }),
      );
      operation.then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
    case 'editor:draft:get': {
      loadEditorDraftState()
        .then(({ draft, revision }) => sendResponse({ ok: true, draft, revision }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'editor:draft:save': {
      saveEditorDraft({
        sourceId: message.sourceId,
        sequence: message.sequence,
        revision: message.revision,
        draft: message.draft,
      })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'editor:draft:clear': {
      clearEditorDraft(message.sourceId, message.sequence, message.revision)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'editor:draft:result': {
      saveEditorDraftResult({
        baseRevision: message.baseRevision,
        text: message.text,
        corrections: message.corrections,
        configKey: message.configKey,
      })
        .then((applied) => sendResponse({ ok: true, applied }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'pending:take': {
      takePendingCorrection()
        .then((pending) => sendResponse({ ok: true, pending }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'setup:verify': {
      handleSetupVerify()
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            status: lastStatus ?? {
              state: 'error',
              progress: 0,
              modelId: '',
              device: 'unknown',
            },
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'setup:complete': {
      activateExistingTabs()
        .then((activatedTabs) => sendResponse({ ok: true, activatedTabs }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            activatedTabs: 0,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
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
  void handleFirstRunInstall(details).catch((error: unknown) =>
    log.error('Could not open first-run Settings.', error),
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
    const result = await handleCorrectAll(text, requestId);
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
    const pending = setPendingCorrection(text);
    void pending.stored.catch((error: unknown) =>
      log.warn('Could not store the selected text for the popup.', error),
    );
    try {
      await chrome.action.openPopup();
      return;
    } catch (error) {
      log.warn('Could not open the popup; correcting on the page instead.', error);
      // Don't leave the handoff behind to hijack the next popup open.
      await clearPendingCorrection(pending.key).catch(() => undefined);
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
    void trackSettingsMutation(
      (async () => {
        const settings = await loadSettings();
        const enabled = isSiteEnabled(settings, origin);
        await saveSettings(setSiteEnabled(settings, origin, !enabled));
      })(),
    ).catch((error: unknown) => log.error('Could not toggle checking for this site.', error));
  }
});

log.info('Service worker started.');
