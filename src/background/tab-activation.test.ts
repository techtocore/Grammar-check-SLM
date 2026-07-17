import { beforeEach, describe, expect, it, vi } from 'vitest';

import { activateExistingTabs } from './tab-activation';

describe('existing tab activation', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('injects the content assets into eligible tabs and skips browser pages', async () => {
    const insertCSS = vi.fn(() => Promise.resolve());
    const executeScript = vi.fn(() => Promise.resolve([]));
    const sendMessage = vi.fn(() => Promise.resolve({ ready: true }));
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn(() =>
          Promise.resolve([
            { id: 1, url: 'https://example.com/editor' },
            { id: 2, url: 'chrome://settings/' },
            { id: 3, url: 'file:///tmp/editor.html' },
          ]),
        ),
        sendMessage,
      },
      scripting: { insertCSS, executeScript },
    });

    await expect(activateExistingTabs()).resolves.toBe(2);
    expect(insertCSS).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, allFrames: true },
      files: ['content.js'],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      { type: 'gc-ready-probe', target: 'content' },
      { frameId: 0 },
    );
  });

  it('continues when a tab rejects injection', async () => {
    const insertCSS = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('restricted'))
      .mockResolvedValueOnce();
    const executeScript = vi.fn(() => Promise.resolve([]));
    const sendMessage = vi.fn(() => Promise.resolve({ ready: true }));
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn(() =>
          Promise.resolve([
            { id: 1, url: 'https://restricted.example' },
            { id: 2, url: 'https://example.com' },
          ]),
        ),
        sendMessage,
      },
      scripting: { insertCSS, executeScript },
    });

    await expect(activateExistingTabs()).resolves.toBe(1);
    expect(executeScript).toHaveBeenCalledOnce();
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 2, allFrames: true },
      files: ['content.js'],
    });
  });

  it('does not count a tab whose content script fails its readiness probe', async () => {
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn(() => Promise.resolve([{ id: 1, url: 'https://example.com' }])),
        sendMessage: vi.fn(() => Promise.resolve({ ready: false })),
      },
      scripting: {
        insertCSS: vi.fn(() => Promise.resolve()),
        executeScript: vi.fn(() => Promise.resolve([])),
      },
    });

    await expect(activateExistingTabs()).resolves.toBe(0);
  });
});
