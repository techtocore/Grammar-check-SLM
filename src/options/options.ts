import {
  isDownloadProgress,
  isOffscreenSender,
  isStatusBroadcast,
  sendToBackground,
  type ModelInfo,
  type ModelStatus,
} from '../shared/messages';
import type { Settings } from '../shared/settings';
import { AUTO_MODEL, getPreset, MODEL_PRESETS } from '../shared/models';
import { promptApiLanguageOptions } from '../shared/prompt-language';
import {
  completeFirstRunSetup,
  FIRST_RUN_QUERY_PARAM,
  isFirstRunSetupPending,
  markFirstRunSetupPending,
} from '../shared/onboarding';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

let settings: Settings | null = null;
let savedTimer: number | null = null;
let models: ModelInfo[] = [];
let activeStatus: ModelStatus | null = null;
let firstRunVisible = false;
let firstRunComplete = false;
let firstRunModelId: string | null = null;
let downloadPollTimer: number | null = null;
let setupChangeInFlight = 0;
let setupTargetRevision = 0;
let modelRefreshGeneration = 0;
let lastPropagatedSetupTarget: string | null = null;
const downloads = new Map<
  string,
  { progress: number; state: 'downloading' | 'error'; error?: string }
>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showPageError(context: string, error: unknown): void {
  const alert = el('page-error');
  alert.textContent = `${context} ${errorMessage(error)}`;
  alert.hidden = false;
}

function parseList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function flashSaved(): void {
  const saved = el('saved');
  saved.hidden = false;
  if (savedTimer !== null) clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => {
    saved.hidden = true;
  }, 1500);
}

async function save(patch: Partial<Settings>): Promise<void> {
  const changesSetupTarget = firstRunVisible && ('model' in patch || 'device' in patch);
  if (changesSetupTarget) {
    setupChangeInFlight++;
    setupTargetRevision++;
    firstRunComplete = false;
    lastPropagatedSetupTarget = null;
    if ('model' in patch) firstRunModelId = null;
  }
  try {
    if (changesSetupTarget) {
      await markFirstRunSetupPending().catch((error: unknown) =>
        showPageError('The new model choice could not be marked for setup.', error),
      );
    }
    const next = await sendToBackground<Settings | null>({
      type: 'settings:set',
      target: 'background',
      patch,
    });
    if (!next) throw new Error('The extension did not return updated settings.');
    settings = next;
  } finally {
    if (changesSetupTarget) setupChangeInFlight--;
  }

  flashSaved();
  render();
  if ('model' in patch || 'backend' in patch || 'device' in patch) {
    try {
      await refreshModels();
    } catch (error) {
      showPageError('Settings were saved, but the model list could not be refreshed.', error);
    }
  }
  try {
    activeStatus = await sendToBackground<ModelStatus | null>({
      type: 'status',
      target: 'background',
    });
  } catch (error) {
    activeStatus = null;
    showPageError('Settings were saved, but model status could not be refreshed.', error);
  }
  renderModelStatus();
}

function saveFromUi(patch: Partial<Settings>): void {
  void save(patch).catch((error: unknown) => {
    showPageError('Could not save Settings.', error);
    if (firstRunVisible) {
      void refreshModels().catch((refreshError: unknown) =>
        showPageError('First-time setup status could not be recovered.', refreshError),
      );
    }
  });
}

// ---- Model manager ----

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `model-btn ${className}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderModelStatus(): void {
  const container = el('model-status');
  container.replaceChildren();
  const status = activeStatus;
  if (!status || status.state === 'idle' || status.state === 'disabled') return;

  const badge = document.createElement('span');
  badge.className = `status-pill ${status.state}`;
  if (status.state === 'loading') badge.textContent = `Loading… ${status.progress}%`;
  else if (status.state === 'ready')
    badge.textContent =
      status.device === 'built-in' ? 'Ready · Chrome AI' : `Ready · ${status.device.toUpperCase()}`;
  else badge.textContent = 'Load failed';
  container.append(badge);

  if (status.state === 'error') {
    container.append(
      button('Retry', 'retry', () => {
        void sendToBackground<ModelStatus>({ type: 'retry', target: 'background' })
          .then((s) => {
            activeStatus = s;
            renderModelStatus();
          })
          .catch((error: unknown) => showPageError('Could not retry the model load.', error));
      }),
    );
    if (status.error) {
      const detail = document.createElement('div');
      detail.className = 'model-error';
      detail.textContent = status.error;
      container.append(detail);
    }
  }
}

function renderModels(): void {
  const list = el('models-list');
  list.replaceChildren();

  for (const model of models) {
    const row = document.createElement('div');
    row.className = 'model-row';

    const info = document.createElement('div');
    info.className = 'model-info';
    const title = document.createElement('div');
    title.className = 'model-title';
    title.textContent = model.label;
    if (model.active) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'badge active';
      activeBadge.textContent = 'Active';
      title.append(activeBadge);
    }
    if (model.cached) {
      const cachedBadge = document.createElement('span');
      cachedBadge.className = 'badge cached';
      cachedBadge.textContent = 'Downloaded';
      title.append(cachedBadge);
    }
    if (model.partial) {
      const partialBadge = document.createElement('span');
      partialBadge.className = 'badge partial';
      partialBadge.textContent = 'Partial download';
      title.append(partialBadge);
    }
    const desc = document.createElement('div');
    desc.className = 'model-desc';
    desc.textContent = `${model.description} · ~${model.approxDownloadMB} MB${
      model.requiresWebGPU ? ' · WebGPU required' : ''
    }`;
    info.append(title, desc);

    const actions = document.createElement('div');
    actions.className = 'model-actions';
    const dl = downloads.get(model.modelId);

    if (dl?.state === 'downloading') {
      const wrap = document.createElement('div');
      wrap.className = 'mini-progress';
      wrap.setAttribute('role', 'progressbar');
      wrap.setAttribute('aria-label', `${model.label} download progress`);
      wrap.setAttribute('aria-valuemin', '0');
      wrap.setAttribute('aria-valuemax', '100');
      wrap.setAttribute('aria-valuenow', String(dl.progress));
      const bar = document.createElement('div');
      bar.className = 'mini-bar';
      bar.style.width = `${dl.progress}%`;
      wrap.append(bar);
      actions.append(wrap);
    } else {
      if (!model.active) {
        actions.append(button('Use', 'use', () => saveFromUi({ model: model.id })));
      }
      if (!model.cached) {
        actions.append(
          button('Download', 'download', () => {
            void startModelDownload(model);
          }),
        );
      }
      if (model.cached || model.partial) {
        actions.append(
          button('Delete', 'delete', () => {
            void deleteModel(model);
          }),
        );
      }
      if (dl?.state === 'error') {
        const err = document.createElement('div');
        err.className = 'model-error';
        err.textContent = dl.error ?? 'Download failed';
        actions.append(err);
      }
    }

    row.append(info, actions);
    list.append(row);
  }
  renderFirstRunSetup();
  syncDownloadPolling();
}

async function refreshModels(): Promise<void> {
  const targetRevision = setupTargetRevision;
  const refreshGeneration = ++modelRefreshGeneration;
  const response = await sendToBackground<ModelInfo[]>({
    type: 'models:list',
    target: 'background',
  });
  if (targetRevision !== setupTargetRevision || refreshGeneration !== modelRefreshGeneration) {
    return;
  }
  if (!Array.isArray(response) || response.length === 0) {
    throw new Error('The local model catalogue could not be loaded.');
  }
  models = response;
  for (const model of models) {
    const status = activeStatus;
    const loadingThisModel =
      status?.state === 'loading' &&
      (status.modelId === model.modelId || (!status.modelId && model.active));
    if (model.download) {
      downloads.set(model.modelId, { ...model.download });
    } else if (model.partial && !model.cached && loadingThisModel) {
      downloads.set(model.modelId, {
        progress: status?.progress ?? 0,
        state: 'downloading',
      });
    } else if (model.partial && !model.cached) {
      downloads.set(model.modelId, {
        progress: 0,
        state: 'error',
        error: 'The previous download was interrupted. Retry it or delete the partial files.',
      });
    } else if (model.cached) {
      downloads.delete(model.modelId);
    } else {
      downloads.delete(model.modelId);
    }
  }
  renderModels();
  if (firstRunVisible && setupChangeInFlight === 0) {
    void beginFirstRunSetup();
  }
}

function syncDownloadPolling(): void {
  const active = [...downloads.values()].some((download) => download.state === 'downloading');
  if (!active) {
    if (downloadPollTimer !== null) window.clearTimeout(downloadPollTimer);
    downloadPollTimer = null;
    return;
  }
  if (downloadPollTimer !== null) return;

  downloadPollTimer = window.setTimeout(() => {
    downloadPollTimer = null;
    void refreshModels()
      .catch((error: unknown) => showPageError('Download status could not be refreshed.', error))
      .finally(syncDownloadPolling);
  }, 3000);
}

async function startModelDownload(model: ModelInfo, purpose?: 'onboarding'): Promise<void> {
  const alreadyDownloading = downloads.get(model.modelId)?.state === 'downloading';
  if (alreadyDownloading && purpose !== 'onboarding') return;

  if (!alreadyDownloading) {
    downloads.set(model.modelId, { progress: 0, state: 'downloading' });
    renderModels();
  }
  if (purpose === 'onboarding') {
    lastPropagatedSetupTarget = setupTargetKey(model);
  }
  try {
    const response = await sendToBackground<{ ok: boolean; error?: string }>({
      type: 'models:download',
      target: 'background',
      modelId: model.modelId,
      purpose,
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? 'The model download could not be started.');
    }
  } catch (error) {
    if (purpose === 'onboarding') lastPropagatedSetupTarget = null;
    downloads.set(model.modelId, {
      progress: 0,
      state: 'error',
      error: errorMessage(error),
    });
    renderModels();
  }
}

async function deleteModel(model: ModelInfo): Promise<void> {
  try {
    const response = await sendToBackground<{ ok: boolean; error?: string }>({
      type: 'models:delete',
      target: 'background',
      modelId: model.modelId,
    });
    if (!response.ok) {
      throw new Error(response.error ?? 'The downloaded model could not be deleted.');
    }
    downloads.delete(model.modelId);
    if (firstRunComplete && firstRunModelId === model.modelId) {
      firstRunComplete = false;
      firstRunVisible = false;
    }
    await refreshModels();
  } catch (error) {
    downloads.set(model.modelId, {
      progress: 0,
      state: 'error',
      error: errorMessage(error),
    });
    renderModels();
  }
}

// ---- First-run setup ----

function firstRunModel(): ModelInfo | undefined {
  const active = models.find((model) => model.active);
  if (firstRunVisible && !firstRunComplete && active && active.modelId !== firstRunModelId) {
    firstRunModelId = active.modelId;
    return active;
  }

  const existing = models.find((model) => model.modelId === firstRunModelId);
  if (existing) return existing;

  const target = active ?? models[0];
  firstRunModelId = target?.modelId ?? null;
  return target;
}

function setupTargetKey(model: ModelInfo): string {
  return `${model.modelId}\u0000${settings?.device ?? 'auto'}`;
}

async function propagateSetupTarget(
  model: ModelInfo,
): Promise<{ ok: boolean; reset: boolean; error?: string }> {
  return sendToBackground<{ ok: boolean; reset: boolean; error?: string }>({
    type: 'models:onboarding:select',
    target: 'background',
    modelId: model.modelId,
    cached: model.cached,
  });
}

function renderFirstRunSetup(): void {
  const card = el('first-run-card');
  card.hidden = !firstRunVisible;
  if (!firstRunVisible) return;

  const copy = el('first-run-copy');
  const status = el('first-run-status');
  const progress = el('first-run-progress');
  const bar = el<HTMLDivElement>('first-run-bar');
  const action = el<HTMLButtonElement>('first-run-action');
  const model = firstRunModel();

  action.hidden = true;
  progress.hidden = false;

  if (model) {
    copy.textContent = `${model.label} is about ${model.approxDownloadMB} MB. It downloads once, stays on this device, and is cached for private offline checks.`;
  }

  if (firstRunComplete || model?.cached) {
    status.textContent = 'Setup complete. The local model is ready for grammar checks.';
    bar.style.width = '100%';
    progress.setAttribute('aria-valuenow', '100');
    return;
  }

  if (!model) {
    status.textContent = 'The local model catalogue could not be loaded.';
    progress.hidden = true;
    action.textContent = 'Retry setup';
    action.hidden = false;
    return;
  }

  const download = downloads.get(model.modelId);
  if (download?.state === 'error') {
    status.textContent = `Download failed: ${download.error ?? 'Unknown error'}`;
    bar.style.width = '0%';
    progress.setAttribute('aria-valuenow', '0');
    action.textContent = 'Retry download';
    action.hidden = false;
    return;
  }

  const percent = download?.state === 'downloading' ? download.progress : 0;
  status.textContent =
    download?.state === 'downloading'
      ? `Downloading ${model.label}... ${percent}%`
      : `Preparing ${model.label} download...`;
  bar.style.width = `${percent}%`;
  progress.setAttribute('aria-valuenow', String(percent));
}

function finishFirstRunSetup(): void {
  if (firstRunComplete || setupChangeInFlight > 0) return;
  firstRunComplete = true;
  renderFirstRunSetup();
  void completeFirstRunSetup()
    .then(removeFirstRunQuery)
    .catch((error: unknown) =>
      showPageError('The model is ready, but setup completion could not be saved.', error),
    );
}

async function beginFirstRunSetup(): Promise<void> {
  if (!firstRunVisible || firstRunComplete || setupChangeInFlight > 0) return;
  const model = firstRunModel();
  if (!model) {
    renderFirstRunSetup();
    return;
  }

  const targetRevision = setupTargetRevision;
  const targetKey = setupTargetKey(model);
  if (lastPropagatedSetupTarget !== targetKey) {
    let response: { ok: boolean; reset: boolean; error?: string };
    try {
      response = await propagateSetupTarget(model);
    } catch (error) {
      if (targetRevision !== setupTargetRevision) return;
      lastPropagatedSetupTarget = null;
      downloads.set(model.modelId, {
        progress: 0,
        state: 'error',
        error: errorMessage(error),
      });
      renderModels();
      return;
    }
    const currentModel = firstRunModel();
    if (
      targetRevision !== setupTargetRevision ||
      !currentModel ||
      setupTargetKey(currentModel) !== targetKey
    ) {
      return;
    }
    if (!response.ok) {
      lastPropagatedSetupTarget = null;
      downloads.set(model.modelId, {
        progress: 0,
        state: 'error',
        error: response.error ?? 'The setup target could not be selected.',
      });
      renderModels();
      return;
    }
    if (response.reset) {
      downloads.delete(model.modelId);
      for (const [modelId, download] of downloads) {
        if (download.state === 'downloading') downloads.delete(modelId);
      }
      renderModels();
    }
    lastPropagatedSetupTarget = targetKey;
  }
  if (model.cached) {
    finishFirstRunSetup();
    return;
  }

  const current = downloads.get(model.modelId);
  if (current?.state === 'downloading' || current?.state === 'error') {
    renderFirstRunSetup();
    return;
  }
  await startModelDownload(model, 'onboarding');
}

async function retryFirstRunSetup(): Promise<void> {
  try {
    if (models.length === 0) await refreshModels();
    const model = firstRunModel();
    if (!model) throw new Error('The local model catalogue is unavailable.');
    lastPropagatedSetupTarget = null;
    downloads.delete(model.modelId);
    await beginFirstRunSetup();
  } catch (error) {
    showPageError('Could not restart first-time setup.', error);
    renderFirstRunSetup();
  }
}

async function initializeFirstRunSetup(): Promise<void> {
  const url = new URL(window.location.href);
  const requested = url.searchParams.get(FIRST_RUN_QUERY_PARAM) === '1';

  if (requested) {
    firstRunVisible = true;
    try {
      await markFirstRunSetupPending();
      removeFirstRunQuery();
    } catch (error) {
      showPageError('First-time setup state could not be saved.', error);
    }
  }

  try {
    if (await isFirstRunSetupPending()) firstRunVisible = true;
  } catch (error) {
    if (!requested) showPageError('First-time setup state could not be loaded.', error);
  }
  renderFirstRunSetup();
}

function removeFirstRunQuery(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(FIRST_RUN_QUERY_PARAM)) return;
  url.searchParams.delete(FIRST_RUN_QUERY_PARAM);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function wireFirstRunSetup(): void {
  el<HTMLButtonElement>('first-run-action').addEventListener('click', () => {
    void retryFirstRunSetup();
  });
}

// ---- Chrome built-in AI (Prompt API) setup ----

function initBuiltinAi(): void {
  const card = el('ai-card');
  const statusEl = el('ai-status');
  const hint = el('ai-hint');
  const setupBtn = el<HTMLButtonElement>('ai-setup');
  const progressWrap = el<HTMLDivElement>('ai-progress');
  const bar = el<HTMLDivElement>('ai-bar');
  const lm = globalThis.LanguageModel;

  card.hidden = false;

  if (!lm) {
    hint.textContent =
      'Chrome built-in AI is not supported in this browser. The extension will use a local model instead.';
    return;
  }

  const setPill = (text: string, cls = ''): void => {
    const pill = document.createElement('span');
    pill.className = `status-pill ${cls}`.trim();
    pill.textContent = text;
    statusEl.replaceChildren(pill);
  };

  const render = (availability: LanguageModelAvailability): void => {
    setupBtn.hidden = true;
    progressWrap.hidden = true;
    if (availability === 'available') {
      setPill('Ready', 'ready');
      hint.textContent = "Chrome's built-in Gemini Nano is ready and used for grammar checks.";
    } else if (availability === 'downloadable') {
      setPill('Not set up');
      hint.textContent =
        'Download Gemini Nano once to enable the fastest, most efficient on-device checking.';
      setupBtn.hidden = false;
    } else if (availability === 'downloading') {
      setPill('Downloading…');
      hint.textContent = 'Chrome is downloading Gemini Nano…';
    } else {
      setPill('Unavailable', 'error');
      hint.textContent =
        'This device does not meet the requirements for Chrome built-in AI. A local model will be used.';
    }
  };

  void lm
    .availability(promptApiLanguageOptions(settings?.language))
    .then(render)
    .catch((error: unknown) => {
      setPill('Status unavailable', 'error');
      hint.textContent = `Chrome built-in AI status could not be checked: ${errorMessage(error)}`;
    });

  setupBtn.addEventListener('click', () => {
    void (async () => {
      setupBtn.disabled = true;
      setupBtn.hidden = true;
      progressWrap.hidden = false;
      bar.style.width = '0%';
      try {
        const session = await lm.create({
          ...promptApiLanguageOptions(settings?.language),
          monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) => {
              bar.style.width = `${Math.round((event as ProgressEvent).loaded * 100)}%`;
              progressWrap.setAttribute(
                'aria-valuenow',
                String(Math.round((event as ProgressEvent).loaded * 100)),
              );
            });
          },
        });
        session.destroy();
        render('available');
      } catch (error) {
        setPill('Set-up failed', 'error');
        hint.textContent = `Set-up failed: ${error instanceof Error ? error.message : String(error)}`;
        progressWrap.hidden = true;
        setupBtn.hidden = false;
      } finally {
        setupBtn.disabled = false;
      }
    })();
  });
}

function modelDescription(id: string): string {
  if (id === AUTO_MODEL) {
    return 'Uses Qwen3.5 0.8B with WebGPU, or Qwen3 0.6B when only WASM is available.';
  }
  const preset = getPreset(id);
  if (!preset) return '';
  return `${preset.description} (~${preset.approxDownloadMB} MB download, cached after first use).`;
}

function backendDescription(backend: Settings['backend']): string {
  if (backend === 'prompt') {
    return "Uses Chrome's built-in Gemini Nano. Chrome may download it during one-time setup. Requires a supported Chrome build.";
  }
  if (backend === 'transformers') {
    return 'Runs a downloaded Transformers.js model locally in supported Chromium browsers.';
  }
  return "Prefers Chrome's built-in AI when available, and falls back to the local model below otherwise.";
}

function render(): void {
  if (!settings) return;
  el<HTMLInputElement>('enabled').checked = settings.enabled;
  el<HTMLSelectElement>('backend').value = settings.backend;
  el('backend-desc').textContent = backendDescription(settings.backend);
  el<HTMLSelectElement>('device').value = settings.device;
  el<HTMLInputElement>('language').value = settings.language;
  el<HTMLInputElement>('debounce').value = String(settings.debounceMs);
  el('debounce-val').textContent = String(settings.debounceMs);
  el<HTMLInputElement>('minWords').value = String(settings.minWords);
  el<HTMLInputElement>('ce').checked = settings.checkContentEditable;
  el<HTMLInputElement>('ti').checked = settings.checkTextInputs;

  const modelSelect = el<HTMLSelectElement>('model');
  if (modelSelect.options.length === 0) {
    modelSelect.add(new Option('Automatic (recommended)', AUTO_MODEL));
    for (const preset of MODEL_PRESETS) modelSelect.add(new Option(preset.label, preset.id));
  }
  modelSelect.value = settings.model;
  el('model-desc').textContent = modelDescription(settings.model);

  // Local model + acceleration only matter when a local model can run. Hide
  // them for the Chrome-AI-only engine so nothing implies a local model is used.
  const localUsed = settings.backend !== 'prompt';
  el('model-field').hidden = !localUsed;
  el('device-field').hidden = !localUsed;
  el('model-label').textContent = settings.backend === 'auto' ? 'Fallback model' : 'Local model';

  el<HTMLSelectElement>('siteMode').value = settings.siteMode;
  el<HTMLTextAreaElement>('allowlist').value = settings.allowlist.join('\n');
  el<HTMLTextAreaElement>('denylist').value = settings.denylist.join('\n');
  el('allow-wrap').hidden = settings.siteMode !== 'allowlist';
  el('deny-wrap').hidden = settings.siteMode !== 'denylist';
}

function wire(): void {
  el<HTMLInputElement>('enabled').addEventListener('change', (e) =>
    saveFromUi({ enabled: (e.target as HTMLInputElement).checked }),
  );
  el<HTMLSelectElement>('backend').addEventListener('change', (e) =>
    saveFromUi({ backend: (e.target as HTMLSelectElement).value as Settings['backend'] }),
  );
  el<HTMLSelectElement>('model').addEventListener('change', (e) =>
    saveFromUi({ model: (e.target as HTMLSelectElement).value }),
  );
  el<HTMLSelectElement>('device').addEventListener('change', (e) => {
    const device = (e.target as HTMLSelectElement).value as Settings['device'];
    const selectedPreset = settings ? getPreset(settings.model) : undefined;
    saveFromUi({
      device,
      ...(device === 'wasm' && selectedPreset?.requiresWebGPU ? { model: AUTO_MODEL } : {}),
    });
  });
  el<HTMLInputElement>('language').addEventListener('change', (e) =>
    saveFromUi({ language: (e.target as HTMLInputElement).value.trim() || 'en' }),
  );
  el<HTMLInputElement>('debounce').addEventListener('input', (e) => {
    el('debounce-val').textContent = (e.target as HTMLInputElement).value;
  });
  el<HTMLInputElement>('debounce').addEventListener('change', (e) =>
    saveFromUi({ debounceMs: Number((e.target as HTMLInputElement).value) }),
  );
  el<HTMLInputElement>('minWords').addEventListener('change', (e) =>
    saveFromUi({ minWords: Math.max(1, Number((e.target as HTMLInputElement).value) || 1) }),
  );
  el<HTMLInputElement>('ce').addEventListener('change', (e) =>
    saveFromUi({ checkContentEditable: (e.target as HTMLInputElement).checked }),
  );
  el<HTMLInputElement>('ti').addEventListener('change', (e) =>
    saveFromUi({ checkTextInputs: (e.target as HTMLInputElement).checked }),
  );
  el<HTMLSelectElement>('siteMode').addEventListener('change', (e) =>
    saveFromUi({ siteMode: (e.target as HTMLSelectElement).value as Settings['siteMode'] }),
  );
  el<HTMLTextAreaElement>('allowlist').addEventListener('change', (e) =>
    saveFromUi({ allowlist: parseList((e.target as HTMLTextAreaElement).value) }),
  );
  el<HTMLTextAreaElement>('denylist').addEventListener('change', (e) =>
    saveFromUi({ denylist: parseList((e.target as HTMLTextAreaElement).value) }),
  );
}

function wireBroadcasts(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isOffscreenSender(sender, chrome.runtime.id)) return;
    if (isStatusBroadcast(message)) {
      activeStatus = message.status;
      renderModelStatus();
      const localLoading =
        message.status.state === 'loading' &&
        (message.status.device === 'webgpu' ||
          message.status.device === 'wasm' ||
          models.some((candidate) => candidate.modelId === message.status.modelId));
      if (localLoading) {
        const model =
          models.find((candidate) => candidate.modelId === message.status.modelId) ??
          models.find((candidate) => candidate.active);
        if (firstRunVisible && model) {
          downloads.set(model.modelId, {
            progress: message.status.progress,
            state: 'downloading',
          });
          renderModels();
        }
      } else if (
        message.status.state === 'error' ||
        (message.status.state === 'ready' && message.status.device !== 'built-in')
      ) {
        void refreshModels().catch((error: unknown) =>
          showPageError('Local model status could not be refreshed.', error),
        );
      }
    } else if (isDownloadProgress(message)) {
      if (message.state === 'downloading') {
        downloads.set(message.modelId, { progress: message.progress, state: 'downloading' });
        renderModels();
      } else if (message.state === 'error') {
        downloads.set(message.modelId, {
          progress: 0,
          state: 'error',
          error: message.error ?? 'Download failed',
        });
        renderModels();
      } else if (message.state === 'cancelled') {
        downloads.delete(message.modelId);
        renderModels();
      } else {
        // done
        downloads.delete(message.modelId);
        void refreshModels().catch((error: unknown) => {
          downloads.set(message.modelId, {
            progress: 0,
            state: 'error',
            error: 'The download finished, but its cache could not be verified. Retry setup.',
          });
          renderModels();
          showPageError('The model downloaded, but its status could not be refreshed.', error);
        });
      }
      renderFirstRunSetup();
    }
  });
}

async function init(): Promise<void> {
  wireBroadcasts();
  wireFirstRunSetup();
  await initializeFirstRunSetup();

  const loaded = await sendToBackground<Settings | null>({
    type: 'settings:get',
    target: 'background',
  });
  if (!loaded) throw new Error('The extension did not return its settings.');
  settings = loaded;
  render();
  wire();
  initBuiltinAi();
  try {
    activeStatus = await sendToBackground<ModelStatus | null>({
      type: 'status',
      target: 'background',
    });
  } catch (error) {
    activeStatus = null;
    showPageError('Model status could not be loaded.', error);
  }
  renderModelStatus();
  await refreshModels();
  await beginFirstRunSetup();
}

void init().catch((error: unknown) => {
  showPageError('Settings could not be initialized.', error);
  renderFirstRunSetup();
});
