import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelStatus, RunnerConfig } from '../shared/messages';
import { applyCorrections } from '../core';
import type { Backend, LoadedBackend } from './backends';
import { Corrector } from './corrector';
import { BackendNotReadyError, downloadTransformersModel } from './backends';
import { deleteModelCache } from '../shared/model-cache';

vi.mock('./backends', () => ({
  BackendNotReadyError: class BackendNotReadyError extends Error {},
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

    const result = await corrector.correct('This sentence have enough words.');

    expect(result).toMatchObject({ complete: true });
    expect(result.corrections).not.toEqual([]);
  });

  it('never turns a Chrome AI answer into grammar suggestions', async () => {
    const backend = fakeBackend(
      vi.fn(() => Promise.resolve('I am doing well, thank you for asking.')),
      'built-in',
    );
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig({ ...CONFIG, backend: 'auto' });

    await expect(corrector.correct('How are you doing?')).resolves.toEqual({
      corrections: [],
      nextOffset: 'How are you doing?'.length,
      complete: true,
    });
  });

  it('handles the reported correction flow without answering the corrected question', async () => {
    const generate = vi.fn((sentence: string) =>
      Promise.resolve(
        sentence === 'How is you doing?'
          ? 'How are you doing?'
          : 'I am doing well, thank you for asking.',
      ),
    );
    const backend = fakeBackend(generate, 'built-in');
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig({ ...CONFIG, backend: 'auto' });

    const firstPass = await corrector.correct('How is you doing?');
    const corrected = applyCorrections('How is you doing?', firstPass.corrections);
    expect(corrected).toBe('How are you doing?');

    const secondPass = await corrector.correct(corrected);
    expect(secondPass.corrections).toEqual([]);
    expect(generate).toHaveBeenCalledWith('How are you doing?');
  });

  it('continues checking text after the first bounded sentence pass', async () => {
    const generate = vi.fn((sentence: string) =>
      Promise.resolve(sentence.replace(' have ', ' has ')),
    );
    const backend = fakeBackend(generate);
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);
    const text = Array.from(
      { length: 61 },
      (_, index) => `This sentence number ${index} have enough words.`,
    ).join(' ');

    const first = await corrector.correct(text);
    const second = await corrector.correct(text, first.nextOffset);

    expect(first.complete).toBe(false);
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(first.nextOffset).toBeLessThan(text.length);
    expect(second.complete).toBe(true);
    expect(second.nextOffset).toBe(text.length);
    expect(second.corrections.some((correction) => correction.start > first.nextOffset)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(61);
  });

  it('quietly falls back to the local backend when Chrome AI is not ready', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const builtIn = fakeBackend(
      vi.fn(() => Promise.resolve('text')),
      'built-in',
      undefined,
      vi.fn(() => Promise.reject(new BackendNotReadyError('Chrome AI is not ready'))),
    );
    const local = fakeBackend(vi.fn(() => Promise.resolve('text')));
    const corrector = new Corrector(vi.fn(), () => [() => builtIn, () => local]);
    await corrector.setConfig({ ...CONFIG, backend: 'auto' });

    await expect(corrector.warmup()).resolves.toBeUndefined();
    expect(corrector.getStatus()).toMatchObject({ state: 'ready', device: 'wasm' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps cache-only misses quiet and lets a real check load normally', async () => {
    const load = vi
      .fn<Backend['load']>()
      .mockRejectedValueOnce(new BackendNotReadyError('No cached model'))
      .mockResolvedValueOnce({ label: 'Fake model', modelId: 'fake-model', device: 'wasm' });
    const backend = fakeBackend(
      vi.fn(() => Promise.resolve('This sentence has enough words.')),
      'wasm',
      undefined,
      load,
    );
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    await expect(corrector.warmup({ cacheOnly: true })).resolves.toBeUndefined();
    expect(corrector.getStatus().state).toBe('idle');

    await expect(corrector.correct('This sentence have enough words.')).resolves.toMatchObject({
      complete: true,
    });
    expect(load.mock.calls[0]?.[0]).toEqual(CONFIG);
    expect(load.mock.calls[0]?.[2]?.cacheOnly).toBe(true);
    expect(load.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(load.mock.calls[1]?.[0]).toEqual(CONFIG);
    expect(load.mock.calls[1]?.[2]?.cacheOnly).toBeUndefined();
    expect(load.mock.calls[1]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not suspend a runner that became active after an idle cutoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const dispose = vi.fn(() => Promise.resolve());
    const backend = fakeBackend(
      vi.fn(() => Promise.resolve('text')),
      'wasm',
      dispose,
    );
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);
    await corrector.warmup({ cacheOnly: true });

    await expect(corrector.suspend(9_999)).resolves.toBe(false);
    expect(dispose).not.toHaveBeenCalled();

    vi.setSystemTime(20_000);
    await expect(corrector.suspend(15_000)).resolves.toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    vi.useRealTimers();
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

  it('clears sentence text from memory when the runner is suspended', async () => {
    const generate = vi.fn(() => Promise.resolve('This sentence has enough words.'));
    const backend = fakeBackend(generate);
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    await corrector.correct('This sentence has enough words.');
    await corrector.suspend();
    await corrector.correct('This sentence has enough words.');

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate the sentence cache from inference finishing during suspension', async () => {
    let finishGeneration: ((value: string) => void) | undefined;
    const generate = vi
      .fn<(sentence: string) => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishGeneration = resolve;
          }),
      )
      .mockImplementation((sentence: string) => Promise.resolve(sentence));
    const backend = fakeBackend(generate);
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    const text = 'This first sentence has enough words. This second sentence has enough words.';
    const checking = corrector.correct(text);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const suspending = corrector.suspend();
    finishGeneration?.('This first sentence has enough words.');
    await Promise.all([checking, suspending]);
    await corrector.correct(text);

    expect(generate).toHaveBeenCalledTimes(4);
  });

  it('cancels checks that were queued before suspension', async () => {
    let finishGeneration: ((value: string) => void) | undefined;
    const generate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishGeneration = resolve;
        }),
    );
    const backend = fakeBackend(generate);
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    const active = corrector.correct('This active sentence has enough words.');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const queued = corrector.correct('This queued sentence has enough words.');
    const suspending = corrector.suspend();
    finishGeneration?.('This active sentence has enough words.');

    await active;
    await expect(queued).rejects.toThrow('model runner changed');
    await suspending;
    expect(generate).toHaveBeenCalledOnce();
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
    expect(download).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      'wasm',
      expect.any(AbortSignal),
    );
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
    expect(
      corrector.selectOnboardingTarget('onnx-community/Qwen3.5-0.8B-ONNX-OPT', 'wasm'),
    ).toMatchObject({
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
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
      'wasm',
      'onboarding',
    );
    const latest = corrector.downloadModel(
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
      'webgpu',
      'onboarding',
    );

    finishFirst?.();
    await Promise.all([first, superseded, latest]);

    expect(download.mock.calls.map(([preset]) => preset.modelId)).toEqual([
      'onnx-community/Qwen3-0.6B-ONNX',
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
    ]);
    expect(corrector.getDownloadStatuses()).toEqual([]);
  });

  it('aborts a running superseded onboarding download without closing the runner', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
    });
    let runningSignal: AbortSignal | undefined;
    const download = vi.mocked(downloadTransformersModel);
    download.mockImplementation(
      (_preset, _onProgress, _device, signal) =>
        new Promise<void>((resolve) => {
          runningSignal = signal;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const corrector = new Corrector(vi.fn());

    const obsolete = corrector.downloadModel(
      'onnx-community/Qwen3-0.6B-ONNX',
      'wasm',
      'onboarding',
    );
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());

    expect(
      corrector.selectOnboardingTarget('onnx-community/Qwen3.5-0.8B-ONNX-OPT', 'webgpu'),
    ).toMatchObject({ hasObsoleteRunning: true });
    await obsolete;

    expect(runningSignal?.aborted).toBe(true);
    expect(corrector.getDownloadStatuses()).toEqual([]);
  });

  it('aborts an obsolete runner load through its backend signal', async () => {
    let loadSignal: AbortSignal | undefined;
    const load = vi.fn<Backend['load']>(
      (_config, _onProgress, policy) =>
        new Promise<LoadedBackend>((_resolve, reject) => {
          loadSignal = policy?.signal;
          policy?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Superseded', 'AbortError')),
            { once: true },
          );
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
      corrector.selectOnboardingTarget('onnx-community/Qwen3.5-0.8B-ONNX-OPT', 'webgpu'),
    ).toMatchObject({ hasObsoleteRunnerLoading: true });
    await warming;

    expect(loadSignal?.aborted).toBe(true);
    expect(corrector.getStatus().state).toBe('idle');
  });

  it('never aborts a model load owned by an active grammar check', async () => {
    let loadSignal: AbortSignal | undefined;
    let finishLoad: (() => void) | undefined;
    const load = vi.fn<Backend['load']>(
      (_config, _onProgress, policy) =>
        new Promise<LoadedBackend>((resolve) => {
          loadSignal = policy?.signal;
          finishLoad = () =>
            resolve({ label: 'Fake model', modelId: 'fake-model', device: 'wasm' });
        }),
    );
    const backend = fakeBackend(
      vi.fn(() => Promise.resolve('I have a cat.')),
      'wasm',
      undefined,
      load,
    );
    const corrector = new Corrector(vi.fn(), () => [() => backend]);
    await corrector.setConfig(CONFIG);

    const checking = corrector.correct('I has a cat.');
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(
      corrector.selectOnboardingTarget('onnx-community/Qwen3.5-0.8B-ONNX-OPT', 'webgpu'),
    ).toMatchObject({ hasObsoleteRunnerLoading: true });
    expect(loadSignal?.aborted).toBe(false);

    finishLoad?.();
    const result = await checking;
    expect(result.corrections).not.toEqual([]);
  });

  it('deletes superseded cache namespaces with the current model', async () => {
    vi.mocked(deleteModelCache).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    const corrector = new Corrector(vi.fn());

    await expect(corrector.deleteModel('onnx-community/Qwen3.5-0.8B-ONNX-OPT')).resolves.toBe(5);
    expect(vi.mocked(deleteModelCache).mock.calls).toEqual([
      ['onnx-community/Qwen3.5-0.8B-ONNX-OPT'],
      ['onnx-community/Qwen3.5-0.8B-ONNX'],
    ]);
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
    const queued = corrector.downloadModel(
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
      'wasm',
      'onboarding',
    );
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
      if (preset.modelId === 'onnx-community/Qwen3-0.6B-ONNX') {
        return new Promise<void>((resolve) => {
          finishBlocker = resolve;
        });
      }
      return Promise.resolve();
    });
    const corrector = new Corrector(vi.fn());

    const blocker = corrector.downloadModel('onnx-community/Qwen3-0.6B-ONNX', 'wasm');
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const wasm = corrector.downloadModel(
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
      'wasm',
      'onboarding',
    );
    const webgpu = corrector.downloadModel(
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
      'webgpu',
      'onboarding',
    );

    finishBlocker?.();
    await Promise.all([blocker, wasm, webgpu]);
    expect(
      download.mock.calls.map(([preset, _onProgress, device]) => [preset.modelId, device]),
    ).toEqual([
      ['onnx-community/Qwen3-0.6B-ONNX', 'wasm'],
      ['onnx-community/Qwen3.5-0.8B-ONNX-OPT', 'webgpu'],
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
