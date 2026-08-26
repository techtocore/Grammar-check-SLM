import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('runner usage persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('throttles persistent writes while retaining the latest useful timestamp', async () => {
    const values: Record<string, unknown> = {};
    const get = vi.fn((key: string) => Promise.resolve({ [key]: values[key] }));
    const set = vi.fn((items: Record<string, unknown>) => {
      Object.assign(values, items);
      return Promise.resolve();
    });
    vi.stubGlobal('chrome', { storage: { local: { get, set } } });
    const { lastGrammarActivity, recordGrammarActivity } = await import('./usage');

    await recordGrammarActivity(1_000);
    await recordGrammarActivity(2_000);

    expect(set).toHaveBeenCalledOnce();
    await expect(lastGrammarActivity()).resolves.toBe(1_000);
  });

  it('ignores malformed stored activity', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(() => Promise.resolve({ runnerUsage: { lastUsedAt: 'yesterday' } })),
          set: vi.fn(() => Promise.resolve()),
        },
      },
    });
    const { lastGrammarActivity } = await import('./usage');

    await expect(lastGrammarActivity()).resolves.toBeNull();
  });
});
