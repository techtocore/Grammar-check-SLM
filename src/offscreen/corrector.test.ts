import { describe, expect, it, vi } from 'vitest';
import type { ModelStatus, RunnerConfig } from '../shared/messages';
import type { Backend, LoadedBackend } from './backends';
import { Corrector } from './corrector';
import { downloadTransformersModel } from './backends';

vi.mock('./backends', () => ({
  downloadTransformersModel: vi.fn(),
  pickBackends: vi.fn(),
}));

const CONFIG: RunnerConfig = {
  backend: 'transformers',
  model: 'auto',
  device: 'wasm',
  language: 'en',
};

function fakeBackend(
  generate: Backend['generate'],
  device: 'wasm' | 'built-in' = 'wasm',
  dispose: Backend['dispose'] = vi.fn(() => Promise.resolve()),
  load: Backend['load'] = vi.fn(() =>
    Promise.resolve({ label: 'Fake model', modelId: 'fake-model', device }),
  ),
): Backend {
  return {
    load,
    generate,
    dispose,
  };
}

describe('Corrector', () => {
  it('surfaces inference failures instead of reporting the sentence as clean', async () => {
    const backend = fakeBackend(vi.fn(() => Promise.reject(new Error('GPU device lost'))));
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    await expect(corrector.correct('This sentence has enough words.')).rejects.toThrow(
      'GPU device lost',
    );
  });

  it('still assembles successful backend output into corrections', async () => {
    const backend = fakeBackend(vi.fn(() => Promise.resolve('This sentence has enough words.')));
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    await expect(corrector.correct('This sentence have enough words.')).resolves.not.toEqual([]);
  });

  it('clears stale error metadata after a successful retry', async () => {
    const statuses: ModelStatus[] = [];
    const failing = fakeBackend(
      vi.fn(() => Promise.resolve('text')),
      'wasm',
      undefined,
      vi.fn(() => Promise.reject(new Error('temporary failure'))),
    );
    const recovered = fakeBackend(vi.fn(() => Promise.resolve('This sentence has enough words.')));
    let attempt = 0;
    const corrector = new Corrector(
      (status) => statuses.push({ ...status }),
      () => [() => (attempt++ === 0 ? failing : recovered)],
    );
    await corrector.setConfig(CONFIG);

    await expect(corrector.correct('This sentence has enough words.')).rejects.toThrow(
      'temporary failure',
    );
    await corrector.reload();

    expect(corrector.getStatus()).toEqual({
      state: 'ready',
      progress: 100,
      modelId: 'fake-model',
      device: 'wasm',
      error: undefined,
      message: undefined,
    });
    expect(statuses.at(-1)?.state).toBe('ready');
  });

  it('waits for active inference before disposing on a built-in language change', async () => {
    let finishGeneration: ((value: string) => void) | undefined;
    const generate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishGeneration = resolve;
        }),
    );
    const dispose = vi.fn(() => Promise.resolve());
    const backend = fakeBackend(generate, 'built-in', dispose);
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    const checking = corrector.correct('This sentence has enough words.');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const changing = corrector.setConfig({ ...CONFIG, language: 'fr' });
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();

    finishGeneration?.('This sentence has enough words.');
    await checking;
    await changing;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('queues downloads behind warmup and releases the loaded backend first', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
    });
    let finishLoad: (() => void) | undefined;
    const dispose = vi.fn(() => Promise.resolve());
    const load = vi.fn(
      () =>
        new Promise<LoadedBackend>((resolve) => {
          finishLoad = () =>
            resolve({ label: 'Fake model', modelId: 'fake-model', device: 'wasm' });
        }),
    );
    const backend = fakeBackend(
      vi.fn(() => Promise.resolve('text')),
      'wasm',
      dispose,
      load,
    );
    const download = vi.mocked(downloadTransformersModel);
    download.mockResolvedValueOnce();
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    const warming = corrector.warmup();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const downloading = corrector.downloadModel('onnx-community/Qwen3-0.6B-ONNX', 'wasm');
    await Promise.resolve();
    expect(download).not.toHaveBeenCalled();

    finishLoad?.();
    await warming;
    await downloading;
    expect(dispose).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'wasm');
  });
});
