import { isStatusBroadcast, sendToBackground, type ModelStatus } from '../shared/messages';
import { isSiteEnabled, originOf, setSiteEnabled, type Settings } from '../shared/settings';
import { AUTO_MODEL, MODEL_PRESETS } from '../shared/models';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

let settings: Settings | null = null;
let origin: string | null = null;

const STATUS_TEXT: Record<ModelStatus['state'], string> = {
  idle: 'Idle — loads on first use',
  loading: 'Loading model…',
  ready: 'Ready',
  error: 'Model failed to load',
  disabled: 'Disabled',
};

function renderStatus(status: ModelStatus | null): void {
  const dot = el('dot');
  const text = el('status-text');
  const progressWrap = el<HTMLDivElement>('progress-wrap');
  const bar = el<HTMLDivElement>('bar');
  const meta = el('meta');
  const errorDetail = el<HTMLDivElement>('error-detail');
  const retry = el<HTMLButtonElement>('retry');

  const state = status?.state ?? 'idle';
  dot.className = `dot ${state}`;
  text.textContent =
    state === 'loading' && status
      ? `Loading model… ${status.progress}%`
      : state === 'error' && status?.message
        ? status.message
        : STATUS_TEXT[state];

  if (state === 'loading' && status) {
    progressWrap.hidden = false;
    bar.style.width = `${status.progress}%`;
  } else {
    progressWrap.hidden = true;
  }

  if (status && (state === 'ready' || state === 'loading')) {
    const preset = MODEL_PRESETS.find((p) => p.modelId === status.modelId);
    const name = preset?.label ?? status.modelId;
    const device = status.device === 'unknown' ? '' : ` · ${status.device.toUpperCase()}`;
    meta.textContent = `${name}${device}`;
  } else {
    meta.textContent = '';
  }

  const isError = state === 'error';
  retry.hidden = !isError;
  errorDetail.hidden = !(isError && status?.error);
  errorDetail.textContent = isError ? (status?.error ?? '') : '';
}

function renderControls(): void {
  if (!settings) return;
  const enabledToggle = el<HTMLInputElement>('toggle-enabled');
  const siteToggle = el<HTMLInputElement>('toggle-site');
  const siteLabel = el('site-label');
  const modelSelect = el<HTMLSelectElement>('model-select');

  enabledToggle.checked = settings.enabled;

  if (origin) {
    siteLabel.textContent = new URL(origin).host;
    siteToggle.checked = isSiteEnabled(settings, origin);
    siteToggle.disabled = !settings.enabled;
  } else {
    siteLabel.textContent = 'Unsupported page';
    siteToggle.checked = false;
    siteToggle.disabled = true;
  }

  if (modelSelect.options.length === 0) {
    const auto = new Option('Automatic (recommended)', AUTO_MODEL);
    modelSelect.add(auto);
    for (const preset of MODEL_PRESETS) modelSelect.add(new Option(preset.label, preset.id));
  }
  modelSelect.value = settings.model;
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settings = await sendToBackground<Settings>({
    type: 'settings:set',
    target: 'background',
    patch,
  });
  renderControls();
}

function wire(): void {
  el<HTMLInputElement>('toggle-enabled').addEventListener('change', (e) => {
    void updateSettings({ enabled: (e.target as HTMLInputElement).checked });
  });
  el<HTMLInputElement>('toggle-site').addEventListener('change', (e) => {
    if (!settings || !origin) return;
    void updateSettings(setSiteEnabled(settings, origin, (e.target as HTMLInputElement).checked));
  });
  el<HTMLSelectElement>('model-select').addEventListener('change', (e) => {
    void updateSettings({ model: (e.target as HTMLSelectElement).value });
  });
  el<HTMLButtonElement>('open-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });
  el<HTMLButtonElement>('retry').addEventListener('click', () => {
    renderStatus({ state: 'loading', progress: 0, modelId: '', device: 'unknown' });
    void sendToBackground<ModelStatus>({ type: 'retry', target: 'background' })
      .then(renderStatus)
      .catch(() => undefined);
  });
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (isStatusBroadcast(message)) renderStatus(message.status);
  });
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  origin = originOf(tab?.url);
  settings = await sendToBackground<Settings>({ type: 'settings:get', target: 'background' });
  renderControls();
  wire();
  renderStatus(
    await sendToBackground<ModelStatus | null>({ type: 'status', target: 'background' }),
  );
}

void init();
