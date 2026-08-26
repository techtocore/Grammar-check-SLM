import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { runtime: { getURL: (path: string) => `chrome-extension://extension/${path}` } },
  });
  Object.defineProperty(globalThis.navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: vi.fn(() => Promise.resolve({})) },
  });
  return {
    deleteModelCache: vi.fn(),
    pipeline: vi.fn(),
    listCompletedModelDevices: vi.fn(),
    markModelDownloadComplete: vi.fn(),
    markModelDownloadStarted: vi.fn(),
  };
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: mocks.pipeline,
  env: {
    allowLocalModels: true,
    useBrowserCache: false,
    backends: { onnx: { wasm: {}, webgpu: {} } },
  },
}));

vi.mock('../shared/model-cache', () => ({
  deleteModelCache: mocks.deleteModelCache,
  listCompletedModelDevices: mocks.listCompletedModelDevices,
  markModelDownloadComplete: mocks.markModelDownloadComplete,
  markModelDownloadStarted: mocks.markModelDownloadStarted,
}));

import { getPreset } from '../shared/models';
import { buildCorrectionRequest } from '../core/prompt';
import { downloadTransformersModel, PromptApiBackend, TransformersBackend } from './backends';

describe('downloadTransformersModel', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    mocks.deleteModelCache.mockResolvedValue(0);
    mocks.listCompletedModelDevices.mockResolvedValue({});
    mocks.markModelDownloadStarted.mockResolvedValue(undefined);
    mocks.markModelDownloadComplete.mockResolvedValue(undefined);
  });

  it('sends Chrome AI an explicit editing request instead of a bare question', async () => {
    const prompt = vi.fn(() => Promise.resolve('How are you doing?'));
    const childSession = { prompt, destroy: vi.fn() };
    const baseSession = {
      clone: vi.fn(() => Promise.resolve(childSession)),
      destroy: vi.fn(),
    };
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(() => Promise.resolve('available')),
      params: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(() => Promise.resolve(baseSession)),
    });
    const backend = new PromptApiBackend();
    await backend.load(
      {
        backend: 'auto',
        model: 'auto',
        device: 'auto',
        language: 'en',
      },
      vi.fn(),
    );

    await expect(backend.generate('How is you doing?')).resolves.toBe('How are you doing?');
    expect(prompt).toHaveBeenCalledWith(buildCorrectionRequest('How is you doing?'));
    expect(childSession.destroy).toHaveBeenCalledOnce();
    await backend.dispose();
  });

  it('does not reload cached weights when writing the completion marker fails', async () => {
    const dispose = vi.fn(() => Promise.resolve());
    mocks.pipeline.mockResolvedValue({ dispose });
    mocks.markModelDownloadComplete.mockRejectedValue(new Error('storage unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const preset = getPreset('qwen3-0.6b');

    await expect(downloadTransformersModel(preset!, vi.fn(), 'wasm')).resolves.toBeUndefined();

    expect(mocks.pipeline).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(mocks.markModelDownloadComplete).toHaveBeenCalledWith(preset!.modelId, 'wasm');
    warn.mockRestore();
  });

  it('keeps an existing model cache usable until its optimized replacement is downloaded', async () => {
    mocks.listCompletedModelDevices.mockResolvedValue({
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT': [],
      'onnx-community/Qwen3.5-0.8B-ONNX': ['webgpu'],
    });
    mocks.pipeline.mockResolvedValue({});
    const backend = new TransformersBackend();

    await expect(
      backend.load(
        {
          backend: 'transformers',
          model: 'qwen3.5-0.8b',
          device: 'webgpu',
          language: 'en',
        },
        vi.fn(),
      ),
    ).resolves.toMatchObject({
      modelId: 'onnx-community/Qwen3.5-0.8B-ONNX',
      device: 'webgpu',
    });

    expect(mocks.pipeline).toHaveBeenCalledWith(
      'text-generation',
      'onnx-community/Qwen3.5-0.8B-ONNX',
      expect.any(Object),
    );
    expect(mocks.deleteModelCache).not.toHaveBeenCalled();
  });

  it('removes a superseded cache after the optimized model is recorded', async () => {
    const dispose = vi.fn(() => Promise.resolve());
    mocks.pipeline.mockResolvedValue({ dispose });
    const preset = getPreset('qwen3.5-0.8b');

    await downloadTransformersModel(preset!, vi.fn(), 'webgpu');

    expect(mocks.markModelDownloadComplete).toHaveBeenCalledWith(preset!.modelId, 'webgpu');
    expect(mocks.deleteModelCache).toHaveBeenCalledWith('onnx-community/Qwen3.5-0.8B-ONNX');
  });

  it('never opens the network path during cache-only local warmup', async () => {
    mocks.listCompletedModelDevices.mockResolvedValue({
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT': [],
      'onnx-community/Qwen3.5-0.8B-ONNX': [],
      'onnx-community/Qwen3-0.6B-ONNX': [],
    });
    const backend = new TransformersBackend();

    await expect(
      backend.load(
        {
          backend: 'transformers',
          model: 'auto',
          device: 'auto',
          language: 'en',
        },
        vi.fn(),
        { cacheOnly: true },
      ),
    ).rejects.toThrow('fully cached');

    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(mocks.markModelDownloadStarted).not.toHaveBeenCalled();
  });

  it('uses local-files-only when warming a completed cache', async () => {
    mocks.listCompletedModelDevices.mockResolvedValue({
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT': ['webgpu'],
      'onnx-community/Qwen3.5-0.8B-ONNX': [],
      'onnx-community/Qwen3-0.6B-ONNX': [],
    });
    mocks.pipeline.mockResolvedValue({});
    const backend = new TransformersBackend();

    await backend.load(
      {
        backend: 'transformers',
        model: 'auto',
        device: 'auto',
        language: 'en',
      },
      vi.fn(),
      { cacheOnly: true },
    );

    expect(mocks.pipeline).toHaveBeenCalledWith(
      'text-generation',
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
      expect.objectContaining({ local_files_only: true }),
    );
    expect(mocks.markModelDownloadStarted).not.toHaveBeenCalled();
  });

  it('does not invalidate a completed cache when its load is cancelled', async () => {
    mocks.listCompletedModelDevices.mockResolvedValue({
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT': ['webgpu'],
      'onnx-community/Qwen3.5-0.8B-ONNX': [],
      'onnx-community/Qwen3-0.6B-ONNX': [],
    });
    mocks.pipeline.mockImplementation(
      (_task, _model, options: { local_files_only?: boolean }) =>
        new Promise((_resolve, reject) => {
          expect(options.local_files_only).toBe(false);
          reject(new DOMException('Superseded', 'AbortError'));
        }),
    );
    const backend = new TransformersBackend();

    await expect(
      backend.load(
        {
          backend: 'transformers',
          model: 'auto',
          device: 'auto',
          language: 'en',
        },
        vi.fn(),
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('Superseded');

    expect(mocks.markModelDownloadStarted).not.toHaveBeenCalled();
    expect(mocks.markModelDownloadComplete).not.toHaveBeenCalled();
  });

  it('prefers an already-cached compatible model in automatic selection', async () => {
    mocks.listCompletedModelDevices.mockResolvedValue({
      'onnx-community/Qwen3.5-0.8B-ONNX-OPT': [],
      'onnx-community/Qwen3.5-0.8B-ONNX': [],
      'onnx-community/Qwen3-0.6B-ONNX': ['wasm'],
    });
    mocks.pipeline.mockResolvedValue({});
    const backend = new TransformersBackend();

    await expect(
      backend.load(
        {
          backend: 'transformers',
          model: 'auto',
          device: 'auto',
          language: 'en',
        },
        vi.fn(),
      ),
    ).resolves.toMatchObject({
      modelId: 'onnx-community/Qwen3-0.6B-ONNX',
      device: 'wasm',
    });
  });

  it('does not start a Chrome AI download during speculative warmup', async () => {
    const create = vi.fn();
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(() => Promise.resolve('downloadable')),
      params: vi.fn(() => Promise.resolve(null)),
      create,
    });
    const backend = new PromptApiBackend();

    await expect(
      backend.load(
        {
          backend: 'prompt',
          model: 'auto',
          device: 'auto',
          language: 'en',
        },
        vi.fn(),
        { cacheOnly: true },
      ),
    ).rejects.toThrow('not ready');
    expect(create).not.toHaveBeenCalled();
  });
});
