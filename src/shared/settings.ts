import type { DevicePreference } from './models';
import { AUTO_MODEL, getPreset } from './models';

export type SiteMode = 'all' | 'allowlist' | 'denylist';

/**
 * Inference backend: `prompt` = Chrome's built-in Gemini Nano (Prompt API),
 * `transformers` = a local Transformers.js model, `auto` = built-in when
 * available, otherwise Transformers.js.
 */
export type Backend = 'auto' | 'prompt' | 'transformers';

export interface Settings {
  /** Global on/off switch. */
  enabled: boolean;
  /** Which inference backend to use. */
  backend: Backend;
  /** Preset id, or `'auto'` to pick based on hardware (Transformers.js only). */
  model: string;
  /** Inference backend preference (Transformers.js only). */
  device: DevicePreference;
  /** Idle time after typing before a check runs (ms). */
  debounceMs: number;
  /** Skip fields with fewer than this many words. */
  minWords: number;
  /** BCP-47 language used for sentence segmentation. */
  language: string;
  /** How the allow/deny lists are interpreted. */
  siteMode: SiteMode;
  /** Origins (e.g. "https://example.com"). */
  allowlist: string[];
  denylist: string[];
  /** Enable checking of <textarea>/<input> fields. */
  checkTextInputs: boolean;
  /** Enable checking of contenteditable fields. */
  checkContentEditable: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  backend: 'transformers',
  model: AUTO_MODEL,
  device: 'auto',
  debounceMs: 900,
  minWords: 3,
  language: 'en',
  siteMode: 'all',
  allowlist: [],
  denylist: [],
  checkTextInputs: true,
  checkContentEditable: true,
};

const STORAGE_KEY = 'settings';
const BACKENDS = new Set<Backend>(['auto', 'prompt', 'transformers']);
const DEVICES = new Set<DevicePreference>(['auto', 'webgpu', 'wasm']);
const SITE_MODES = new Set<SiteMode>(['all', 'allowlist', 'denylist']);
let saveQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function languageTag(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim().replaceAll('_', '-');
  if (!candidate || candidate.length > 100) return fallback;
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? fallback;
  } catch {
    return fallback;
  }
}

function originList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const origins = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(originOf)
    .filter((origin): origin is string => origin !== null);
  return [...new Set(origins)].slice(0, 500);
}

/** Validates untrusted persisted settings or a partial update against a known base. */
export function normalizeSettings(value: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const input = isRecord(value) ? value : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    backend: enumValue(input.backend, BACKENDS, base.backend),
    model:
      typeof input.model === 'string' &&
      (input.model === AUTO_MODEL || getPreset(input.model) !== undefined)
        ? input.model
        : base.model,
    device: enumValue(input.device, DEVICES, base.device),
    debounceMs: boundedInteger(input.debounceMs, base.debounceMs, 300, 2500),
    minWords: boundedInteger(input.minWords, base.minWords, 1, 50),
    language: languageTag(input.language, base.language),
    siteMode: enumValue(input.siteMode, SITE_MODES, base.siteMode),
    allowlist: originList(input.allowlist, base.allowlist),
    denylist: originList(input.denylist, base.denylist),
    checkTextInputs:
      typeof input.checkTextInputs === 'boolean' ? input.checkTextInputs : base.checkTextInputs,
    checkContentEditable:
      typeof input.checkContentEditable === 'boolean'
        ? input.checkContentEditable
        : base.checkContentEditable,
  };
}

async function readStoredSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

/** Loads validated settings from chrome.storage, failing closed when storage is unavailable. */
export async function loadSettings(): Promise<Settings> {
  try {
    return await readStoredSettings();
  } catch {
    return { ...DEFAULT_SETTINGS, enabled: false };
  }
}

/** Merges a patch into the stored settings and returns the result. */
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const operation = saveQueue.then(async () => {
    const current = await readStoredSettings();
    const next = normalizeSettings(patch, current);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  });
  saveQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

/** Subscribes to settings changes; returns an unsubscribe function. */
export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
    callback(normalizeSettings(changes[STORAGE_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Normalizes a URL to its origin, or null for unsupported schemes. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    // Local files share a single opaque origin; treat them as one site so the
    // extension works on file:// test pages (requires "Allow access to file URLs").
    if (parsed.protocol === 'file:') return 'file://';
    return null;
  } catch {
    return null;
  }
}

/** Whether checking is enabled for a given site origin under the current settings. */
export function isSiteEnabled(settings: Settings, origin: string | null): boolean {
  if (!settings.enabled) return false;
  const normalizedOrigin = originOf(origin ?? undefined);
  if (!normalizedOrigin) return false;
  switch (settings.siteMode) {
    case 'allowlist':
      return settings.allowlist.includes(normalizedOrigin);
    case 'denylist':
      return !settings.denylist.includes(normalizedOrigin);
    case 'all':
    default:
      return true;
  }
}

/** Computes a settings patch that enables/disables checking for a specific origin. */
export function setSiteEnabled(
  settings: Settings,
  origin: string,
  enabled: boolean,
): Partial<Settings> {
  const normalizedOrigin = originOf(origin);
  if (!normalizedOrigin) return {};
  if (settings.siteMode === 'allowlist') {
    const set = new Set(settings.allowlist);
    if (enabled) set.add(normalizedOrigin);
    else set.delete(normalizedOrigin);
    return { allowlist: [...set] };
  }
  const set = new Set(settings.denylist);
  if (enabled) set.delete(normalizedOrigin);
  else set.add(normalizedOrigin);
  // In "all" mode, disabling a single site switches to denylist mode.
  const siteMode: SiteMode =
    settings.siteMode === 'all' && !enabled ? 'denylist' : settings.siteMode;
  return { denylist: [...set], siteMode };
}
