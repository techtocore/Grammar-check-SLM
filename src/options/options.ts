import { sendToBackground } from '../shared/messages';
import type { Settings } from '../shared/settings';
import { AUTO_MODEL, getPreset, MODEL_PRESETS } from '../shared/models';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

let settings: Settings | null = null;
let savedTimer: number | null = null;

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
}

function modelDescription(id: string): string {
  if (id === AUTO_MODEL) {
    return 'Picks Qwen3 1.7B on WebGPU-capable devices, or the faster Qwen3 0.6B otherwise.';
  }
  const preset = getPreset(id);
  if (!preset) return '';
  return `${preset.description} (~${preset.approxDownloadMB} MB download, cached after first use).`;
}

function render(): void {
  if (!settings) return;
  el<HTMLInputElement>('enabled').checked = settings.enabled;
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

async function init(): Promise<void> {
  settings = await sendToBackground<Settings>({ type: 'settings:get', target: 'background' });
  render();
  wire();
}

void init();
