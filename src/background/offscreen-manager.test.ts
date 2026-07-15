import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeOffscreen, ensureOffscreen } from './offscreen-manager';

describe('ensureOffscreen', () => {
  beforeEach(() => vi.unstubAllGlobals());

  function installChrome(
    contexts: chrome.runtime.ExtensionContext[][],
    createDocument: () => Promise<void>,
  ): void {
    const snapshots = [...contexts];
    vi.stubGlobal('chrome', {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getURL: vi.fn((path: string) => `chrome-extension://extension/${path}`),
        getContexts: vi.fn(() => Promise.resolve(snapshots.shift() ?? [])),
      },
      offscreen: {
        Reason: { WORKERS: 'WORKERS' },
        createDocument: vi.fn(createDocument),
        closeDocument: vi.fn(() => Promise.resolve()),
      },
    });
  }

  it('propagates a genuine document creation failure', async () => {
    installChrome([[], []], () => Promise.reject(new Error('offscreen permission denied')));
    await expect(ensureOffscreen()).rejects.toThrow('offscreen permission denied');
  });

  it('accepts a create race only when the document now exists', async () => {
    installChrome(
      [[], [{ contextType: 'OFFSCREEN_DOCUMENT' } as chrome.runtime.ExtensionContext]],
      () => Promise.reject(new Error('Only a single offscreen document may be created')),
    );
    await expect(ensureOffscreen()).resolves.toBeUndefined();
  });

  it('serializes close behind an in-progress creation', async () => {
    let exists = false;
    let finishCreation: (() => void) | undefined;
    const createDocument = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCreation = () => {
            exists = true;
            resolve();
          };
        }),
    );
    const closeDocument = vi.fn(() => {
      exists = false;
      return Promise.resolve();
    });
    vi.stubGlobal('chrome', {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getURL: vi.fn((path: string) => `chrome-extension://extension/${path}`),
        getContexts: vi.fn(() =>
          Promise.resolve(
            exists
              ? [{ contextType: 'OFFSCREEN_DOCUMENT' } as chrome.runtime.ExtensionContext]
              : [],
          ),
        ),
      },
      offscreen: {
        Reason: { WORKERS: 'WORKERS' },
        createDocument,
        closeDocument,
      },
    });

    const creating = ensureOffscreen();
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledOnce());
    const closing = closeOffscreen();
    finishCreation?.();
    await Promise.all([creating, closing]);
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(exists).toBe(false);
  });
});
