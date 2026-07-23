import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPendingCorrection, setPendingCorrection, takePendingCorrection } from './pending';

function installSessionStorage() {
  const values: Record<string, unknown> = {};
  const get = vi.fn((key: string | string[] | null) => {
    if (key === null) return Promise.resolve(structuredClone(values));
    const keys = Array.isArray(key) ? key : [key];
    return Promise.resolve(
      Object.fromEntries(
        keys.filter((entry) => entry in values).map((entry) => [entry, values[entry]]),
      ),
    );
  });
  const set = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(values, structuredClone(patch));
    return Promise.resolve();
  });
  const remove = vi.fn((key: string | string[]) => {
    for (const entry of Array.isArray(key) ? key : [key]) delete values[entry];
    return Promise.resolve();
  });
  vi.stubGlobal('chrome', { storage: { session: { get, set, remove } } });
  return { values, get, set, remove };
}

describe('pending correction handoff', () => {
  let id = 0;

  beforeEach(() => {
    vi.unstubAllGlobals();
    id = 0;
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `handoff-${++id}`) });
  });

  it('consumes the newest handoff and clears older selections', async () => {
    const storage = installSessionStorage();
    const first = setPendingCorrection('First selection');
    const second = setPendingCorrection('Second selection');
    await Promise.all([first.stored, second.stored]);

    await expect(takePendingCorrection()).resolves.toMatchObject({ text: 'Second selection' });
    expect(storage.values).toEqual({});
    await expect(takePendingCorrection()).resolves.toBeNull();
  });

  it('clears only the handoff whose popup failed to open', async () => {
    installSessionStorage();
    const first = setPendingCorrection('First selection');
    const second = setPendingCorrection('Second selection');
    await Promise.all([first.stored, second.stored]);

    await clearPendingCorrection(first.key);

    await expect(takePendingCorrection()).resolves.toMatchObject({ text: 'Second selection' });
  });

  it('leaves a selection queued after an earlier take operation', async () => {
    const storage = installSessionStorage();
    const first = setPendingCorrection('First selection');
    await first.stored;

    let releaseGet: (() => void) | undefined;
    storage.get.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          const snapshot = structuredClone(storage.values);
          releaseGet = () => resolve(snapshot);
        }),
    );

    const taking = takePendingCorrection();
    await vi.waitFor(() => expect(storage.get).toHaveBeenCalled());
    const second = setPendingCorrection('Second selection');
    releaseGet?.();

    await expect(taking).resolves.toMatchObject({ text: 'First selection' });
    await second.stored;
    await expect(takePendingCorrection()).resolves.toMatchObject({ text: 'Second selection' });
  });
});
