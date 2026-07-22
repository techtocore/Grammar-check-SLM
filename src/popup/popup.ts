import {
  isOffscreenSender,
  isStatusBroadcast,
  newRequestId,
  sendToBackground,
  type CheckResult,
  type ModelStatus,
} from '../shared/messages';
import { isSiteEnabled, originOf, setSiteEnabled, type Settings } from '../shared/settings';
import { AUTO_MODEL, MODEL_PRESETS } from '../shared/models';
import { promptApiLanguageOptions } from '../shared/prompt-language';
import { takePendingCorrection } from '../shared/pending';
import { clearEditorDraft, loadEditorDraft, saveEditorDraft } from '../shared/editor-draft';
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
let lastCorrections: Correction[] | null = null;
let draftSaveSeq = 0;

const pageUrl = new URL(window.location.href);
const expandedView = pageUrl.searchParams.get('view') === 'expanded';

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
  // The header already shows the compact status ("Ready · Chrome AI"), so only
  // surface the standalone card when it adds something: a loading progress bar
  // or an error with a Retry button. This keeps the Controls panel compact.
  el('status-card').hidden = state !== 'loading' && state !== 'error';
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
    progressWrap.setAttribute('aria-valuenow', String(status.progress));
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
  retry.hidden = !isError || status?.modelId === 'popup';
  errorDetail.hidden = !(isError && status?.error);
  errorDetail.textContent = isError ? (status?.error ?? '') : '';
}

function renderStatus(status: ModelStatus | null): void {
  activeStatus = status;
  const state = status?.state ?? 'idle';
  el('header-dot').className = `header-dot ${state}`;
  el('header-status').textContent = compactStatus(status);
  renderStatusCard(status);
  updateEditorHint();
}

function reportPopupError(context: string, error: unknown): void {
  renderStatus({
    state: 'error',
    progress: 0,
    modelId: 'popup',
    device: 'unknown',
    message: context,
    error: errorMessage(error),
  });
}

// ============================ Editor ============================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setHint(text: string): void {
  el('editor-hint').textContent = text;
}

function setDraftStatus(text: string, state: 'normal' | 'error' = 'normal', detail = ''): void {
  const status = el('editor-save-status');
  status.textContent = text;
  status.dataset.state = state;
  status.title = detail
    ? `Drafts are stored only on this device. ${detail}`
    : 'Drafts are stored only on this device.';
}

function hideResult(): void {
  el('editor-result').hidden = true;
  lastCorrected = '';
  lastCorrections = null;
}

async function persistEditorState(): Promise<boolean> {
  const seq = ++draftSaveSeq;
  const text = el<HTMLTextAreaElement>('editor-input').value;
  try {
    if (text.length === 0) {
      await clearEditorDraft();
    } else {
      await saveEditorDraft({
        text,
        ...(lastCorrections === null ? {} : { corrections: lastCorrections }),
      });
    }
    if (seq === draftSaveSeq) setDraftStatus(text.length === 0 ? 'Cleared' : 'Saved');
    return true;
  } catch (error) {
    if (seq === draftSaveSeq) setDraftStatus('Not saved', 'error', errorMessage(error));
    return false;
  }
}

function updateEditorControls(): void {
  const input = el<HTMLTextAreaElement>('editor-input');
  const length = input.value.length;
  el('editor-count').textContent = `${length} character${length === 1 ? '' : 's'}`;
  el<HTMLButtonElement>('editor-correct').disabled = inFlight || !input.value.trim();
  el<HTMLButtonElement>('editor-clear').disabled = length === 0;
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

function renderResult(text: string, corrections: Correction[], persist = true): void {
  lastCorrections = corrections.map((correction) => ({ ...correction }));
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
  if (persist) void persistEditorState();
}

async function correctNow(text: string): Promise<void> {
  const seq = ++editorSeq;
  inFlight = true;
  updateEditorControls();
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
      updateEditorControls();
      setHint('Something went wrong. Try again.');
    }
    return;
  }

  if (seq !== editorSeq) return;
  inFlight = false;
  updateEditorControls();
  // Only render if the input still matches what we corrected.
  if (el<HTMLTextAreaElement>('editor-input').value !== text) return;
  if (result.error) {
    setHint(result.error);
    return;
  }
  renderResult(text, result.corrections);
}

function runEditorCorrect(): void {
  if (editorTimer !== null) clearTimeout(editorTimer);
  const text = el<HTMLTextAreaElement>('editor-input').value;
  if (!text.trim()) {
    editorSeq++; // cancel any in-flight render
    inFlight = false;
    hideResult();
    setHint('');
    updateEditorControls();
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

async function openExpandedEditor(): Promise<void> {
  const button = el<HTMLButtonElement>('open-editor-page');
  button.disabled = true;
  if (!(await persistEditorState())) {
    button.disabled = false;
    return;
  }

  const url = new URL(chrome.runtime.getURL('popup.html'));
  url.searchParams.set('view', 'expanded');
  if (origin) url.searchParams.set('origin', origin);
  try {
    await chrome.tabs.create({ url: url.toString(), active: true });
  } catch (error) {
    setHint(`Could not open the full-page editor: ${errorMessage(error)}`);
  } finally {
    button.disabled = false;
  }
}

function wireEditor(): void {
  const input = el<HTMLTextAreaElement>('editor-input');
  input.addEventListener('input', () => {
    editorSeq++;
    inFlight = false;
    hideResult();
    setHint('');
    updateEditorControls();
    void persistEditorState();
    scheduleEditorCorrect();
  });
  el<HTMLButtonElement>('editor-correct').addEventListener('click', () => runEditorCorrect());
  el<HTMLButtonElement>('editor-clear').addEventListener('click', () => {
    if (editorTimer !== null) clearTimeout(editorTimer);
    editorTimer = null;
    editorSeq++;
    inFlight = false;
    input.value = '';
    hideResult();
    setHint('');
    updateEditorControls();
    void persistEditorState();
    input.focus();
  });
  el<HTMLButtonElement>('editor-copy').addEventListener('click', () => void copyResult());
  el<HTMLButtonElement>('editor-use').addEventListener('click', () => {
    const corrected = lastCorrected;
    editorSeq++;
    inFlight = false;
    input.value = corrected;
    hideResult();
    updateEditorControls();
    void persistEditorState();
    input.focus();
    runEditorCorrect();
  });
  el<HTMLButtonElement>('open-editor-page').addEventListener('click', () => {
    void openExpandedEditor();
  });
  // Ctrl/Cmd+Enter to correct immediately.
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runEditorCorrect();
    }
  });
  updateEditorControls();
}

// ============================ Tabs ============================

function activateTab(name: string): void {
  document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  el('panel-editor').hidden = name !== 'editor';
  el('panel-controls').hidden = name !== 'controls';
  if (name === 'editor') el<HTMLTextAreaElement>('editor-input').focus();
}

function wireTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab ?? 'editor'));
    tab.addEventListener('keydown', (event) => {
      let next: number;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      const nextTab = tabs[next];
      if (!nextTab) return;
      activateTab(nextTab.dataset.tab ?? 'editor');
      nextTab.focus();
    });
  });
}

// ============================ Controls ============================

function renderControls(): void {
  if (!settings) return;
  el<HTMLInputElement>('toggle-enabled').checked = settings.enabled;

  const siteToggle = el<HTMLInputElement>('toggle-site');
  const siteLabel = el('site-label');
  if (origin) {
    // Local files share one opaque origin; label it "This page" (clearer than
    // "file://"). Toggling it enables/disables checking on local file pages.
    siteLabel.textContent = origin === 'file://' ? 'This page' : new URL(origin).host;
    siteToggle.checked = isSiteEnabled(settings, origin);
    siteToggle.disabled = !settings.enabled;
  } else {
    siteLabel.textContent = 'Unsupported page';
    siteToggle.checked = false;
    siteToggle.disabled = true;
  }

  const modelSelect = el<HTMLSelectElement>('model-select');
  if (modelSelect.options.length === 0) {
    modelSelect.add(new Option('Recommended for this device', AUTO_MODEL));
    for (const preset of MODEL_PRESETS) modelSelect.add(new Option(preset.label, preset.id));
  }
  modelSelect.value = settings.model;

  renderEngine();
}

// ---- Engine picker ----

type AiAvailability = LanguageModelAvailability | 'unsupported';
let aiAvailability: AiAvailability | null = null;

const BACKEND_DESC: Record<Settings['backend'], string> = {
  auto: "Uses Chrome's built-in AI only when ready, otherwise the local model.",
  prompt: "Uses Chrome's built-in Gemini Nano, which Chrome may download during setup.",
  transformers: 'Runs a downloaded local model in supported Chromium browsers.',
};

function engineDescription(backend: Settings['backend']): string {
  if (backend === 'prompt') {
    if (aiAvailability === 'unavailable' || aiAvailability === 'unsupported') {
      return "Chrome built-in AI isn't available here. Pick Automatic or Local instead.";
    }
    if (aiAvailability === 'downloadable' || aiAvailability === 'downloading') {
      return 'Chrome built-in Gemini Nano — tap the badge above to set it up once.';
    }
  }
  return BACKEND_DESC[backend];
}

function renderEngineBadge(backend: Settings['backend']): void {
  const badge = el<HTMLButtonElement>('engine-badge');
  // Only relevant when Chrome AI can actually be used.
  if (backend === 'transformers' || aiAvailability === null) {
    badge.hidden = true;
    return;
  }
  const map: Record<AiAvailability, { text: string; cls: string }> = {
    available: { text: 'Chrome AI ready', cls: 'ok' },
    downloadable: { text: 'Set up Chrome AI →', cls: 'warn' },
    downloading: { text: 'Downloading Chrome AI…', cls: 'warn' },
    unavailable: { text: 'Chrome AI unavailable', cls: 'muted' },
    unsupported: { text: 'Chrome AI unavailable', cls: 'muted' },
  };
  const { text, cls } = map[aiAvailability];
  badge.textContent = text;
  badge.className = `engine-badge ${cls}`;
  badge.hidden = false;
}

function renderEngine(): void {
  if (!settings) return;
  const backend = settings.backend;

  document.querySelectorAll<HTMLButtonElement>('.seg').forEach((seg) => {
    const active = seg.dataset.backend === backend;
    seg.classList.toggle('active', active);
    seg.setAttribute('aria-checked', String(active));
    seg.tabIndex = active ? 0 : -1;
  });

  el('engine-desc').textContent = engineDescription(backend);

  // Hide the local model picker for Chrome AI (it isn't used there); show it for
  // Automatic (as the fallback model) and Local. This now actually takes effect
  // thanks to the global `[hidden]` rule overriding `.engine-model{display:flex}`.
  el('engine-model').hidden = backend === 'prompt';
  el('model-label').textContent = backend === 'auto' ? 'Fallback model' : 'Local model';

  renderEngineBadge(backend);
}

async function loadAiAvailability(): Promise<void> {
  const lm = globalThis.LanguageModel;
  if (!lm) {
    aiAvailability = 'unsupported';
  } else {
    try {
      aiAvailability = await lm.availability(promptApiLanguageOptions(settings?.language));
    } catch {
      aiAvailability = 'unsupported';
    }
  }
  renderEngine();
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const next = await sendToBackground<Settings | null>({
    type: 'settings:set',
    target: 'background',
    patch,
  });
  if (!next) throw new Error('The extension did not return updated settings.');
  settings = next;
  renderControls();
  try {
    renderStatus(
      await sendToBackground<ModelStatus | null>({ type: 'status', target: 'background' }),
    );
  } catch (error) {
    reportPopupError('Settings were saved, but model status could not be refreshed.', error);
  }
}

function updateSettingsFromUi(patch: Partial<Settings>): void {
  void updateSettings(patch).catch((error: unknown) =>
    reportPopupError('Settings could not be saved.', error),
  );
}

function openOptionsPage(): void {
  void chrome.runtime
    .openOptionsPage()
    .catch((error: unknown) => reportPopupError('Settings could not be opened.', error));
}

function wireControls(): void {
  el<HTMLInputElement>('toggle-enabled').addEventListener('change', (e) => {
    updateSettingsFromUi({ enabled: (e.target as HTMLInputElement).checked });
  });
  el<HTMLInputElement>('toggle-site').addEventListener('change', (e) => {
    if (!settings || !origin) return;
    updateSettingsFromUi(setSiteEnabled(settings, origin, (e.target as HTMLInputElement).checked));
  });
  el<HTMLSelectElement>('model-select').addEventListener('change', (e) => {
    updateSettingsFromUi({ model: (e.target as HTMLSelectElement).value });
  });
  const segments = [...document.querySelectorAll<HTMLButtonElement>('.seg')];
  const chooseSegment = (seg: HTMLButtonElement): void => {
    const backend = seg.dataset.backend as Settings['backend'] | undefined;
    if (backend && backend !== settings?.backend) updateSettingsFromUi({ backend });
  };
  segments.forEach((seg, index) => {
    seg.addEventListener('click', () => {
      chooseSegment(seg);
    });
    seg.addEventListener('keydown', (event) => {
      let next: number;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        next = (index - 1 + segments.length) % segments.length;
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        next = (index + 1) % segments.length;
      } else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = segments.length - 1;
      else return;
      event.preventDefault();
      const nextSegment = segments[next];
      if (!nextSegment) return;
      chooseSegment(nextSegment);
      nextSegment.focus();
    });
  });
  el<HTMLButtonElement>('engine-badge').addEventListener('click', () => {
    // The badge only acts as a shortcut to set up Chrome AI in Settings.
    if (aiAvailability === 'downloadable' || aiAvailability === 'downloading') {
      openOptionsPage();
    }
  });
  el<HTMLButtonElement>('open-options').addEventListener('click', openOptionsPage);
  el<HTMLButtonElement>('open-options-2').addEventListener('click', openOptionsPage);
  el<HTMLButtonElement>('retry').addEventListener('click', () => {
    renderStatus({ state: 'loading', progress: 0, modelId: '', device: 'unknown' });
    void sendToBackground<ModelStatus>({ type: 'retry', target: 'background' })
      .then(renderStatus)
      .catch((error: unknown) => reportPopupError('The model retry could not be started.', error));
  });
}

// ============================ Init ============================

/**
 * If the popup was opened from the "Correct grammar of…" context menu on
 * non-editable text, pick up that selection, drop it into the editor, and
 * correct it right away. Returns true when a pending selection was handled.
 */
async function consumePendingCorrection(): Promise<boolean> {
  let pending: Awaited<ReturnType<typeof takePendingCorrection>>;
  try {
    pending = await takePendingCorrection();
  } catch {
    return false;
  }
  const text = pending?.text;
  if (!text?.trim()) return false;

  activateTab('editor');
  const input = el<HTMLTextAreaElement>('editor-input');
  input.value = text;
  updateEditorControls();
  input.focus();
  await persistEditorState();
  runEditorCorrect();
  return true;
}

async function restoreEditorDraft(): Promise<{ restored: boolean; hasResult: boolean }> {
  let draft: Awaited<ReturnType<typeof loadEditorDraft>>;
  try {
    draft = await loadEditorDraft();
  } catch (error) {
    setDraftStatus('Unavailable', 'error', errorMessage(error));
    return { restored: false, hasResult: false };
  }
  if (!draft) return { restored: false, hasResult: false };

  const input = el<HTMLTextAreaElement>('editor-input');
  input.value = draft.text;
  hideResult();
  updateEditorControls();
  if (draft.corrections !== undefined) renderResult(draft.text, draft.corrections, false);
  setDraftStatus('Restored');
  return { restored: true, hasResult: draft.corrections !== undefined };
}

async function init(): Promise<void> {
  document.body.classList.toggle('expanded-view', expandedView);
  el<HTMLButtonElement>('open-editor-page').hidden = expandedView;
  if (expandedView) {
    document.title = 'Grammar Check Editor';
    el('app-title').textContent = 'Grammar Check Editor';
  }

  wireTabs();
  wireEditor();
  wireControls();

  const requestedOrigin = expandedView
    ? originOf(pageUrl.searchParams.get('origin') ?? undefined)
    : null;
  if (requestedOrigin) {
    origin = requestedOrigin;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    origin = originOf(tab?.url);
  }
  settings = await sendToBackground<Settings | null>({
    type: 'settings:get',
    target: 'background',
  });
  if (!settings) throw new Error('The extension did not return its settings.');

  renderControls();
  void loadAiAvailability();

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (isOffscreenSender(sender, chrome.runtime.id) && isStatusBroadcast(message)) {
      renderStatus(message.status);
    }
  });

  // Opening the popup should not initiate a potentially large model download.
  // The first actual correction (or focused page field) loads it on demand.
  renderStatus(
    await sendToBackground<ModelStatus | null>({ type: 'status', target: 'background' }),
  );

  // A pending selection (from the context menu) takes over the editor; otherwise
  // restore the durable draft and resume an unfinished automatic check.
  if (!(await consumePendingCorrection())) {
    const restored = await restoreEditorDraft();
    const input = el<HTMLTextAreaElement>('editor-input');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (restored.restored && !restored.hasResult) {
      scheduleEditorCorrect(expandedView ? 250 : 700);
    }
  }
}

void init().catch((error: unknown) =>
  reportPopupError('The popup could not be initialized.', error),
);
