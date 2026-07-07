import {
  isStatusBroadcast,
  newRequestId,
  sendToBackground,
  type CheckResult,
  type ModelStatus,
} from '../shared/messages';
import { isSiteEnabled, originOf, setSiteEnabled, type Settings } from '../shared/settings';
import { AUTO_MODEL, MODEL_PRESETS } from '../shared/models';
import { applyCorrections, type Correction } from '../core';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

let settings: Settings | null = null;
let origin: string | null = null;
let activeStatus: ModelStatus | null = null;

// ---- Editor state ----
let editorSeq = 0;
let editorTimer: number | null = null;
let inFlight = false;
let lastCorrected = '';

const STATUS_TEXT: Record<ModelStatus['state'], string> = {
  idle: 'Idle — loads on first use',
  loading: 'Loading model…',
  ready: 'Ready',
  error: 'Model failed to load',
  disabled: 'Disabled',
};

// ============================ Status ============================

function compactStatus(status: ModelStatus | null): string {
  const state = status?.state ?? 'idle';
  if (state === 'loading' && status) return `Loading model… ${status.progress}%`;
  if (state === 'ready' && status) {
    if (status.device === 'built-in') return 'Ready · Chrome AI';
    return status.device === 'unknown' ? 'Ready' : `Ready · ${status.device.toUpperCase()}`;
  }
  if (state === 'error') return 'Model error — see Controls';
  if (state === 'disabled') return 'Disabled';
  return 'Private · on-device AI';
}

function renderStatusCard(status: ModelStatus | null): void {
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
    const device =
      status.device === 'unknown' || status.device === 'built-in'
        ? ''
        : ` · ${status.device.toUpperCase()}`;
    meta.textContent = `${name}${device}`;
  } else {
    meta.textContent = '';
  }

  const isError = state === 'error';
  retry.hidden = !isError;
  errorDetail.hidden = !(isError && status?.error);
  errorDetail.textContent = isError ? (status?.error ?? '') : '';
}

function renderStatus(status: ModelStatus | null): void {
  activeStatus = status;
  el('header-status').textContent = compactStatus(status);
  renderStatusCard(status);
  updateEditorHint();
}

// ============================ Editor ============================

function setHint(text: string): void {
  el('editor-hint').textContent = text;
}

function hideResult(): void {
  el('editor-result').hidden = true;
  lastCorrected = '';
}

function updateEditorHint(): void {
  if (!inFlight) return;
  const state = activeStatus?.state;
  if (state === 'loading') setHint(`Loading model… ${activeStatus?.progress ?? 0}%`);
  else if (state === 'error') setHint(activeStatus?.message ?? 'Model failed to load.');
  else setHint('Checking…');
}

interface DiffPart {
  text: string;
  changed: boolean;
}

function buildDiff(text: string, corrections: readonly Correction[]): DiffPart[] {
  const sorted = [...corrections].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: DiffPart[] = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.start < cursor) continue; // ignore any overlap defensively
    if (c.start > cursor) parts.push({ text: text.slice(cursor, c.start), changed: false });
    if (c.suggestion) parts.push({ text: c.suggestion, changed: true });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), changed: false });
  return parts;
}

function renderResult(text: string, corrections: Correction[]): void {
  lastCorrected = applyCorrections(text, corrections);
  const count = corrections.length;

  const resultCount = el('result-count');
  resultCount.textContent =
    count === 0 ? '✓ Looks good' : `${count} correction${count === 1 ? '' : 's'}`;
  resultCount.className = `result-count ${count === 0 ? 'clean' : 'changed'}`;

  const body = el('result-body');
  body.replaceChildren(
    ...buildDiff(text, corrections).map((part) => {
      if (!part.changed) return document.createTextNode(part.text);
      const mark = document.createElement('mark');
      mark.className = 'diff-add';
      mark.textContent = part.text;
      return mark;
    }),
  );

  el<HTMLButtonElement>('editor-use').hidden = count === 0;
  el('editor-result').hidden = false;
  setHint('');
}

async function correctNow(text: string): Promise<void> {
  const seq = ++editorSeq;
  inFlight = true;
  updateEditorHint();

  let result: CheckResult;
  try {
    result = await sendToBackground<CheckResult>({
      type: 'correct',
      target: 'background',
      requestId: newRequestId(),
      text,
    });
  } catch {
    if (seq === editorSeq) {
      inFlight = false;
      setHint('Something went wrong. Try again.');
    }
    return;
  }

  if (seq !== editorSeq) return;
  inFlight = false;
  // Only render if the input still matches what we corrected.
  if (el<HTMLTextAreaElement>('editor-input').value.trim() !== text) return;
  if (result.error) {
    setHint(result.error);
    return;
  }
  renderResult(text, result.corrections);
}

function runEditorCorrect(): void {
  if (editorTimer !== null) clearTimeout(editorTimer);
  const text = el<HTMLTextAreaElement>('editor-input').value.trim();
  if (!text) {
    editorSeq++; // cancel any in-flight render
    inFlight = false;
    hideResult();
    setHint('');
    return;
  }
  void correctNow(text);
}

function scheduleEditorCorrect(delay = 700): void {
  if (editorTimer !== null) clearTimeout(editorTimer);
  editorTimer = window.setTimeout(() => runEditorCorrect(), delay);
}

async function copyResult(): Promise<void> {
  const copyBtn = el<HTMLButtonElement>('editor-copy');
  const original = copyBtn.textContent;
  const flash = (label: string): void => {
    copyBtn.textContent = label;
    copyBtn.classList.add('copied');
    window.setTimeout(() => {
      copyBtn.textContent = original ?? 'Copy';
      copyBtn.classList.remove('copied');
    }, 1200);
  };
  try {
    await navigator.clipboard.writeText(lastCorrected);
    flash('Copied!');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = lastCorrected;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      flash('Copied!');
    } catch {
      flash('Press Ctrl+C');
    }
    ta.remove();
  }
}

function wireEditor(): void {
  const input = el<HTMLTextAreaElement>('editor-input');
  input.addEventListener('input', () => scheduleEditorCorrect());
  el<HTMLButtonElement>('editor-correct').addEventListener('click', () => runEditorCorrect());
  el<HTMLButtonElement>('editor-clear').addEventListener('click', () => {
    input.value = '';
    hideResult();
    setHint('');
    input.focus();
  });
  el<HTMLButtonElement>('editor-copy').addEventListener('click', () => void copyResult());
  el<HTMLButtonElement>('editor-use').addEventListener('click', () => {
    input.value = lastCorrected;
    input.focus();
    runEditorCorrect();
  });
  // Ctrl/Cmd+Enter to correct immediately.
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runEditorCorrect();
    }
  });
}

// ============================ Tabs ============================

function activateTab(name: string): void {
  document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });
  el('panel-editor').hidden = name !== 'editor';
  el('panel-controls').hidden = name !== 'controls';
  if (name === 'editor') el<HTMLTextAreaElement>('editor-input').focus();
}

function wireTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab ?? 'editor'));
  });
}

// ============================ Controls ============================

function renderControls(): void {
  if (!settings) return;
  el<HTMLInputElement>('toggle-enabled').checked = settings.enabled;

  const siteToggle = el<HTMLInputElement>('toggle-site');
  const siteLabel = el('site-label');
  if (origin) {
    siteLabel.textContent = origin === 'file://' ? 'Local files' : new URL(origin).host;
    siteToggle.checked = isSiteEnabled(settings, origin);
    siteToggle.disabled = !settings.enabled;
  } else {
    siteLabel.textContent = 'Unsupported page';
    siteToggle.checked = false;
    siteToggle.disabled = true;
  }

  const modelSelect = el<HTMLSelectElement>('model-select');
  if (modelSelect.options.length === 0) {
    modelSelect.add(new Option('Automatic (recommended)', AUTO_MODEL));
    for (const preset of MODEL_PRESETS) modelSelect.add(new Option(preset.label, preset.id));
  }
  modelSelect.value = settings.model;

  el<HTMLSelectElement>('backend-select').value = settings.backend;
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settings = await sendToBackground<Settings>({
    type: 'settings:set',
    target: 'background',
    patch,
  });
  renderControls();
}

function wireControls(): void {
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
  el<HTMLSelectElement>('backend-select').addEventListener('change', (e) => {
    void updateSettings({ backend: (e.target as HTMLSelectElement).value as Settings['backend'] });
  });
  const openOptions = (): void => void chrome.runtime.openOptionsPage();
  el<HTMLButtonElement>('open-options').addEventListener('click', openOptions);
  el<HTMLButtonElement>('open-options-2').addEventListener('click', openOptions);
  el<HTMLButtonElement>('retry').addEventListener('click', () => {
    renderStatus({ state: 'loading', progress: 0, modelId: '', device: 'unknown' });
    void sendToBackground<ModelStatus>({ type: 'retry', target: 'background' })
      .then(renderStatus)
      .catch(() => undefined);
  });
}

// ============================ Init ============================

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  origin = originOf(tab?.url);
  settings = await sendToBackground<Settings>({ type: 'settings:get', target: 'background' });

  renderControls();
  wireTabs();
  wireEditor();
  wireControls();

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (isStatusBroadcast(message)) renderStatus(message.status);
  });

  // Warm up the model (this also loads it) and reflect the result. Show an
  // optimistic "loading" immediately so the user never sees a confusing "Idle"
  // while the model is being prepared.
  if (settings.enabled) {
    renderStatus({ state: 'loading', progress: 0, modelId: '', device: 'unknown' });
    void sendToBackground<ModelStatus>({ type: 'warmup', target: 'background' })
      .then((status) => renderStatus(status))
      .catch(() => undefined);
  } else {
    renderStatus(
      await sendToBackground<ModelStatus | null>({ type: 'status', target: 'background' }),
    );
  }

  el<HTMLTextAreaElement>('editor-input').focus();
}

void init();
