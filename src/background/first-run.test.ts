import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFirstRunInstall } from './first-run';

describe('first-run installation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installChrome(options: { tabFailure?: Error; storageFailure?: Error } = {}) {
    const storageFailure = options.storageFailure;
    const tabFailure = options.tabFailure;
    const set = storageFailure
      ? vi.fn(() => Promise.reject(storageFailure))
      : vi.fn(() => Promise.resolve());
    const create = tabFailure
      ? vi.fn(() => Promise.reject(tabFailure))
      : vi.fn(() => Promise.resolve({}));
    const openOptionsPage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', {
      storage: { local: { set } },
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://extension/${path}`),
        openOptionsPage,
      },
      tabs: { create },
    });
    return { create, openOptionsPage, set };
  }

  it('opens Settings with first-run setup only for a fresh install', async () => {
    const api = installChrome();

    await handleFirstRunInstall({ reason: 'install' });

    expect(api.set).toHaveBeenCalledWith({ firstRunSetupPending: true });
    expect(api.create).toHaveBeenCalledWith({
      url: 'chrome-extension://extension/options.html?firstRun=1',
      active: true,
    });
    expect(api.openOptionsPage).not.toHaveBeenCalled();
  });

  it('does nothing on extension updates', async () => {
    const api = installChrome();

    await handleFirstRunInstall({ reason: 'update', previousVersion: '0.9.0' });

    expect(api.set).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('falls back to the registered options page when tab creation fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = installChrome({ tabFailure: new Error('tabs unavailable') });

    await handleFirstRunInstall({ reason: 'install' });

    expect(api.openOptionsPage).toHaveBeenCalledOnce();
  });

  it('still opens setup when the pending marker cannot be stored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = installChrome({ storageFailure: new Error('storage unavailable') });

    await handleFirstRunInstall({ reason: 'install' });

    expect(api.create).toHaveBeenCalledOnce();
  });

  it('retries persistence before using the options-page fallback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const set = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce();
    const openOptionsPage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', {
      storage: { local: { set } },
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://extension/${path}`),
        openOptionsPage,
      },
      tabs: { create: vi.fn(() => Promise.reject(new Error('tabs unavailable'))) },
    });

    await handleFirstRunInstall({ reason: 'install' });

    expect(set).toHaveBeenCalledTimes(2);
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
});
