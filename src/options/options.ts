import {
  isDownloadProgress,
  isStatusBroadcast,
  sendToBackground,
  type ModelInfo,
  type ModelStatus,
} from '../shared/messages';
import type { Settings } from '../shared/settings';
import { AUTO_MODEL, getPreset, MODEL_PRESETS } from '../shared/models';
import { promptApiLanguageOptions } from '../shared/prompt-language';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

let settings: Settings | null = null;
let savedTimer: number | null = null;
let models: ModelInfo[] = [];
let activeStatus: ModelStatus | null = null;
const downloads = new Map<
  string,
  { progress: number; state: 'downloading' | 'error'; error?: string }
>();

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
  settings = await sendToBackground<Settings>({
    type: 'settings:set',
    target: 'background',
    patch,
  });
  flashSaved();
  render();
  if ('model' in patch || 'backend' in patch) void refreshModels();
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
        void sendToBackground<ModelStatus>({ type: 'retry', target: 'background' }).then((s) => {
          activeStatus = s;
          renderModelStatus();
        });
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
    const desc = document.createElement('div');
    desc.className = 'model-desc';
    desc.textContent = `${model.description} · ~${model.approxDownloadMB} MB${
      model.requiresWebGPU ? ' · WebGPU recommended' : ''
    }`;
    info.append(title, desc);

    const actions = document.createElement('div');
    actions.className = 'model-actions';
    const dl = downloads.get(model.modelId);

    if (dl?.state === 'downloading') {
      const wrap = document.createElement('div');
      wrap.className = 'mini-progress';
      const bar = document.createElement('div');
      bar.className = 'mini-bar';
      bar.style.width = `${dl.progress}%`;
      wrap.append(bar);
      actions.append(wrap);
    } else {
      if (!model.active) {
        actions.append(button('Use', 'use', () => void save({ model: model.id })));
      }
      if (model.cached) {
        actions.append(
          button('Delete', 'delete', () => {
            void sendToBackground({
              type: 'models:delete',
              target: 'background',
              modelId: model.modelId,
            }).then(() => refreshModels());
          }),
        );
      } else {
        actions.append(
          button('Download', 'download', () => {
            downloads.set(model.modelId, { progress: 0, state: 'downloading' });
            renderModels();
            void sendToBackground({
              type: 'models:download',
              target: 'background',
              modelId: model.modelId,
            });
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
}

async function refreshModels(): Promise<void> {
  models = await sendToBackground<ModelInfo[]>({ type: 'models:list', target: 'background' });
  renderModels();
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

  void lm.availability(promptApiLanguageOptions(settings?.language)).then(render);

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
            });
          },
        });
        session.destroy();
        render('available');
      } catch (error) {
        hint.textContent = `Set-up failed: ${error instanceof Error ? error.message : String(error)}`;
        render(await lm.availability(promptApiLanguageOptions(settings?.language)));
      } finally {
        setupBtn.disabled = false;
      }
    })();
  });
}

function modelDescription(id: string): string {
  if (id === AUTO_MODEL) {
    return 'Uses the recommended Qwen3 0.6B model — fast and reliable on most devices.';
  }
  const preset = getPreset(id);
  if (!preset) return '';
  return `${preset.description} (~${preset.approxDownloadMB} MB download, cached after first use).`;
}

function backendDescription(backend: Settings['backend']): string {
  if (backend === 'prompt') {
    return "Uses Chrome's built-in Gemini Nano — instant and private, with no model download. Requires a supported Chrome build (set it up below).";
  }
  if (backend === 'transformers') {
    return 'Always runs a local Transformers.js model you download — works in any browser.';
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
  el<HTMLInputElement>('enabled').addEventListener(
    'change',
    (e) => void save({ enabled: (e.target as HTMLInputElement).checked }),
  );
  el<HTMLSelectElement>('backend').addEventListener(
    'change',
    (e) => void save({ backend: (e.target as HTMLSelectElement).value as Settings['backend'] }),
  );
  el<HTMLSelectElement>('model').addEventListener(
    'change',
    (e) => void save({ model: (e.target as HTMLSelectElement).value }),
  );
  el<HTMLSelectElement>('device').addEventListener(
    'change',
    (e) => void save({ device: (e.target as HTMLSelectElement).value as Settings['device'] }),
  );
  el<HTMLInputElement>('language').addEventListener(
    'change',
    (e) => void save({ language: (e.target as HTMLInputElement).value.trim() || 'en' }),
  );
  el<HTMLInputElement>('debounce').addEventListener('input', (e) => {
    el('debounce-val').textContent = (e.target as HTMLInputElement).value;
  });
  el<HTMLInputElement>('debounce').addEventListener(
    'change',
    (e) => void save({ debounceMs: Number((e.target as HTMLInputElement).value) }),
  );
  el<HTMLInputElement>('minWords').addEventListener(
    'change',
    (e) => void save({ minWords: Math.max(1, Number((e.target as HTMLInputElement).value) || 1) }),
  );
  el<HTMLInputElement>('ce').addEventListener(
    'change',
    (e) => void save({ checkContentEditable: (e.target as HTMLInputElement).checked }),
  );
  el<HTMLInputElement>('ti').addEventListener(
    'change',
    (e) => void save({ checkTextInputs: (e.target as HTMLInputElement).checked }),
  );
  el<HTMLSelectElement>('siteMode').addEventListener(
    'change',
    (e) => void save({ siteMode: (e.target as HTMLSelectElement).value as Settings['siteMode'] }),
  );
  el<HTMLTextAreaElement>('allowlist').addEventListener(
    'change',
    (e) => void save({ allowlist: parseList((e.target as HTMLTextAreaElement).value) }),
  );
  el<HTMLTextAreaElement>('denylist').addEventListener(
    'change',
    (e) => void save({ denylist: parseList((e.target as HTMLTextAreaElement).value) }),
  );
}

function wireBroadcasts(): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (isStatusBroadcast(message)) {
      activeStatus = message.status;
      renderModelStatus();
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
      } else {
        // done
        downloads.delete(message.modelId);
        void refreshModels();
      }
    }
  });
}

async function init(): Promise<void> {
  settings = await sendToBackground<Settings>({ type: 'settings:get', target: 'background' });
  render();
  wire();
  wireBroadcasts();
  initBuiltinAi();
  await refreshModels();
  activeStatus = await sendToBackground<ModelStatus | null>({
    type: 'status',
    target: 'background',
  });
  renderModelStatus();
}

void init();
