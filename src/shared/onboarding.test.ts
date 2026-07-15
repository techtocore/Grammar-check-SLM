import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeFirstRunSetup,
  isFirstRunSetupPending,
  markFirstRunSetupPending,
} from './onboarding';

describe('first-run setup storage', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('persists and clears the pending marker', async () => {
    const values: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((key: string) => Promise.resolve({ [key]: values[key] })),
          set: vi.fn((patch: Record<string, unknown>) => {
            Object.assign(values, patch);
            return Promise.resolve();
          }),
          remove: vi.fn((key: string) => {
            delete values[key];
            return Promise.resolve();
          }),
        },
      },
    });

    await expect(isFirstRunSetupPending()).resolves.toBe(false);
    await markFirstRunSetupPending();
    await expect(isFirstRunSetupPending()).resolves.toBe(true);
    await completeFirstRunSetup();
    await expect(isFirstRunSetupPending()).resolves.toBe(false);
  });

  it('serializes completion before a newer pending marker', async () => {
    const values: Record<string, unknown> = { firstRunSetupPending: true };
    let finishRemove: (() => void) | undefined;
    const set = vi.fn((patch: Record<string, unknown>) => {
      Object.assign(values, patch);
      return Promise.resolve();
    });
    const remove = vi.fn(
      (key: string) =>
        new Promise<void>((resolve) => {
          finishRemove = () => {
            delete values[key];
            resolve();
          };
        }),
    );
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((key: string) => Promise.resolve({ [key]: values[key] })),
          set,
          remove,
        },
      },
    });

    const completing = completeFirstRunSetup();
    const marking = markFirstRunSetupPending();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(set).not.toHaveBeenCalled();

    finishRemove?.();
    await Promise.all([completing, marking]);
    await expect(isFirstRunSetupPending()).resolves.toBe(true);
  });
});
