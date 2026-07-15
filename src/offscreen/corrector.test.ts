import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelStatus, RunnerConfig } from '../shared/messages';
import type { Backend, LoadedBackend } from './backends';
import { Corrector } from './corrector';
import { downloadTransformersModel } from './backends';
import { deleteModelCache } from '../shared/model-cache';

vi.mock('./backends', () => ({
  downloadTransformersModel: vi.fn(),
  pickBackends: vi.fn(),
}));
vi.mock('../shared/model-cache', () => ({
  deleteModelCache: vi.fn(),
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
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(downloadTransformersModel).mockReset();
    vi.mocked(deleteModelCache).mockReset();
  });

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

  it('reports whether an active runner load matches the onboarding target', async () => {
    let finishLoad: (() => void) | undefined;
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
      undefined,
      load,
    );
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    const warming = corrector.warmup();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(
      corrector.selectOnboardingTarget('onnx-community/Qwen3-0.6B-ONNX', 'wasm'),
    ).toMatchObject({
      hasMatchingRunnerLoading: true,
      hasObsoleteRunnerLoading: false,
    });
    expect(corrector.selectOnboardingTarget('Xenova/flan-t5-base', 'wasm')).toMatchObject({
      hasMatchingRunnerLoading: false,
      hasObsoleteRunnerLoading: true,
    });

    finishLoad?.();
    await warming;
  });

  it('deduplicates concurrent downloads and exposes resumable progress', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
    });
    let finishDownload: (() => void) | undefined;
    const download = vi.mocked(downloadTransformersModel);
    download.mockImplementationOnce(
      (_preset, onProgress) =>
        new Promise<void>((resolve) => {
          onProgress(37);
          finishDownload = resolve;
        }),
    );
    const corrector = new Corrector(vi.fn());

    const first = corrector.downloadModel('onnx-community/Qwen3-0.6B-ONNX', 'wasm');
    const duplicate = corrector.downloadModel('onnx-community/Qwen3-0.6B-ONNX', 'wasm');

    expect(duplicate).toBe(first);
    await expect(corrector.deleteModel('onnx-community/Qwen3-0.6B-ONNX')).rejects.toThrow(
      'Wait for the active download to finish.',
    );
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(corrector.getDownloadStatuses()).toEqual([
      {
        modelId: 'onnx-community/Qwen3-0.6B-ONNX',
        state: 'downloading',
        progress: 37,
      },
    ]);

    let suspended = false;
    const suspending = corrector.suspend().then(() => {
      suspended = true;
    });
    await Promise.resolve();
    expect(suspended).toBe(false);

    finishDownload?.();
    await Promise.all([first, duplicate, suspending]);
    expect(download).toHaveBeenCalledOnce();
    expect(suspended).toBe(true);
    expect(corrector.getDownloadStatuses()).toEqual([]);
    vi.mocked(deleteModelCache).mockResolvedValueOnce(3);
    await expect(corrector.deleteModel('onnx-community/Qwen3-0.6B-ONNX')).resolves.toBe(3);
  });

  it('skips superseded onboarding downloads that have not started', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
    });
    let finishFirst: (() => void) | undefined;
    const download = vi.mocked(downloadTransformersModel);
    download.mockImplementation((preset) => {
      if (preset.modelId === 'onnx-community/Qwen3-0.6B-ONNX') {
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    const corrector = new Corrector(vi.fn());

    const first = corrector.downloadModel('onnx-community/Qwen3-0.6B-ONNX', 'wasm', 'onboarding');
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const superseded = corrector.downloadModel(
      'onnx-community/Qwen3-1.7B-ONNX',
      'wasm',
      'onboarding',
    );
    const latest = corrector.downloadModel('Xenova/flan-t5-base', 'wasm', 'onboarding');

    finishFirst?.();
    await Promise.all([first, superseded, latest]);

    expect(download.mock.calls.map(([preset]) => preset.modelId)).toEqual([
      'onnx-community/Qwen3-0.6B-ONNX',
      'Xenova/flan-t5-base',
    ]);
    expect(corrector.getDownloadStatuses()).toEqual([]);
  });

  it('cancels a queued model when onboarding switches back to the active download', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
    });
    let finishFirst: (() => void) | undefined;
    const download = vi.mocked(downloadTransformersModel);
    download.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const corrector = new Corrector(vi.fn());

    const first = corrector.downloadModel('onnx-community/Qwen3-0.6B-ONNX', 'wasm', 'onboarding');
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const queued = corrector.downloadModel('onnx-community/Qwen3-1.7B-ONNX', 'wasm', 'onboarding');
    expect(corrector.selectOnboardingTarget('onnx-community/Qwen3-0.6B-ONNX', 'wasm')).toEqual({
      hasMatchingRunning: true,
      hasObsoleteRunning: false,
      hasMatchingRunnerLoading: false,
      hasObsoleteRunnerLoading: false,
      clearedObsoleteStatus: false,
    });
    const selectedAgain = corrector.downloadModel(
      'onnx-community/Qwen3-0.6B-ONNX',
      'wasm',
      'onboarding',
    );

    expect(selectedAgain).toBe(first);
    finishFirst?.();
    await Promise.all([first, queued, selectedAgain]);
    expect(download).toHaveBeenCalledOnce();
  });

  it('supersedes a queued download when acceleration changes for the same model', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
    });
    let finishBlocker: (() => void) | undefined;
    const download = vi.mocked(downloadTransformersModel);
    download.mockImplementation((preset) => {
      if (preset.modelId === 'Xenova/flan-t5-base') {
        return new Promise<void>((resolve) => {
          finishBlocker = resolve;
        });
      }
      return Promise.resolve();
    });
    const corrector = new Corrector(vi.fn());

    const blocker = corrector.downloadModel('Xenova/flan-t5-base', 'wasm');
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const wasm = corrector.downloadModel('onnx-community/Qwen3-0.6B-ONNX', 'wasm', 'onboarding');
    const webgpu = corrector.downloadModel(
      'onnx-community/Qwen3-0.6B-ONNX',
      'webgpu',
      'onboarding',
    );

    finishBlocker?.();
    await Promise.all([blocker, wasm, webgpu]);
    expect(
      download.mock.calls.map(([preset, _onProgress, device]) => [preset.modelId, device]),
    ).toEqual([
      ['Xenova/flan-t5-base', 'wasm'],
      ['onnx-community/Qwen3-0.6B-ONNX', 'webgpu'],
    ]);
  });

  it('clears a failed device status when onboarding selects another device', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
    });
    vi.mocked(downloadTransformersModel).mockRejectedValueOnce(new Error('WebGPU failed'));
    const corrector = new Corrector(vi.fn());

    await expect(
      corrector.downloadModel('onnx-community/Qwen3-0.6B-ONNX', 'webgpu', 'onboarding'),
    ).rejects.toThrow('WebGPU failed');
    expect(corrector.getDownloadStatuses()).toHaveLength(1);

    expect(
      corrector.selectOnboardingTarget('onnx-community/Qwen3-0.6B-ONNX', 'wasm'),
    ).toMatchObject({ clearedObsoleteStatus: true });
    expect(corrector.getDownloadStatuses()).toEqual([]);
  });
});
