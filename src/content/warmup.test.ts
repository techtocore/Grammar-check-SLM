import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('requestCachedWarmup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('coalesces editing-intent warmups within a frame', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ state: 'idle' }));
    vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage } });
    const { requestCachedWarmup } = await import('./warmup');

    requestCachedWarmup(100_000);
    requestCachedWarmup(100_001);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await Promise.resolve();

    requestCachedWarmup(159_999);
    requestCachedWarmup(160_000);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  });
});
