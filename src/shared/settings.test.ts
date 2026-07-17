import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  isSiteEnabled,
  loadSettings,
  normalizeSettings,
  saveSettings,
  setSiteEnabled,
  type Settings,
} from './settings';

function installStorage(initial: Partial<Settings> = {}): {
  getStored: () => Settings;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  let stored = normalizeSettings(initial);
  const get = vi.fn(async () => {
    const snapshot = structuredClone(stored);
    await Promise.resolve();
    return { settings: snapshot };
  });
  const set = vi.fn((values: { settings: Settings }) => {
    stored = structuredClone(values.settings);
    return Promise.resolve();
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: { get, set },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  return { getStored: () => stored, get, set };
}

describe('settings normalization', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('uses the local engine prepared by first-run setup by default', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      backend: 'transformers',
      model: 'auto',
      device: 'auto',
    });
  });

  it('validates enums, numbers, models, and language tags', () => {
    expect(
      normalizeSettings({
        backend: 'remote',
        model: 'unknown-model',
        device: 'cuda',
        debounceMs: Number.POSITIVE_INFINITY,
        minWords: 500,
        language: 'en_US',
      }),
    ).toMatchObject({
      backend: DEFAULT_SETTINGS.backend,
      model: DEFAULT_SETTINGS.model,
      device: DEFAULT_SETTINGS.device,
      debounceMs: DEFAULT_SETTINGS.debounceMs,
      minWords: 50,
      language: 'en-US',
    });
  });

  it('canonicalizes, deduplicates, and filters site origins', () => {
    const settings = normalizeSettings({
      siteMode: 'denylist',
      denylist: [
        'https://EXAMPLE.com/path',
        'https://example.com/',
        'http://example.com:8080/a',
        'javascript:alert(1)',
        'not a URL',
        'file:///tmp/example.html',
      ],
    });

    expect(settings.denylist).toEqual([
      'https://example.com',
      'http://example.com:8080',
      'file://',
    ]);
    expect(isSiteEnabled(settings, 'https://example.com/another-page')).toBe(false);
    expect(isSiteEnabled(settings, 'https://other.example')).toBe(true);
  });

  it('normalizes origins when toggling a site', () => {
    const patch = setSiteEnabled(DEFAULT_SETTINGS, 'https://EXAMPLE.com/path', false);
    expect(patch).toEqual({ denylist: ['https://example.com'], siteMode: 'denylist' });
  });

  it('fails closed when settings storage cannot be read', async () => {
    const storage = installStorage();
    storage.get.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(loadSettings()).resolves.toMatchObject({ enabled: false });
  });

  it('serializes concurrent patches so disjoint changes survive', async () => {
    const storage = installStorage();
    const [disabled, adjusted] = await Promise.all([
      saveSettings({ enabled: false }),
      saveSettings({ minWords: 7 }),
    ]);

    expect(disabled.enabled).toBe(false);
    expect(adjusted).toMatchObject({ enabled: false, minWords: 7 });
    expect(storage.getStored()).toMatchObject({ enabled: false, minWords: 7 });
    expect(storage.set).toHaveBeenCalledTimes(2);
  });
});
