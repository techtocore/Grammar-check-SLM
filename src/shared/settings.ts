import type { DevicePreference } from './models';
import { AUTO_MODEL } from './models';

export type SiteMode = 'all' | 'allowlist' | 'denylist';

export interface Settings {
  /** Global on/off switch. */
  enabled: boolean;
  /** Preset id, or `'auto'` to pick based on hardware. */
  model: string;
  /** Inference backend preference. */
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

/** Loads settings from chrome.storage, merged over defaults. */
export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merges a patch into the stored settings and returns the result. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Subscribes to settings changes; returns an unsubscribe function. */
export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
    callback({ ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY]?.newValue as Partial<Settings>) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Normalizes a URL to its origin, or null for unsupported schemes. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, origin } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return origin;
  } catch {
    return null;
  }
}

/** Whether checking is enabled for a given site origin under the current settings. */
export function isSiteEnabled(settings: Settings, origin: string | null): boolean {
  if (!settings.enabled) return false;
  if (!origin) return false;
  switch (settings.siteMode) {
    case 'allowlist':
      return settings.allowlist.includes(origin);
    case 'denylist':
      return !settings.denylist.includes(origin);
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
  if (settings.siteMode === 'allowlist') {
    const set = new Set(settings.allowlist);
    if (enabled) set.add(origin);
    else set.delete(origin);
    return { allowlist: [...set] };
  }
  const set = new Set(settings.denylist);
  if (enabled) set.delete(origin);
  else set.add(origin);
  // In "all" mode, disabling a single site switches to denylist mode.
  const siteMode: SiteMode =
    settings.siteMode === 'all' && !enabled ? 'denylist' : settings.siteMode;
  return { denylist: [...set], siteMode };
}
