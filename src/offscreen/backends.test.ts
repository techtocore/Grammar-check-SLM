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
    getCompletedModelDevices: vi.fn(),
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
  getCompletedModelDevices: mocks.getCompletedModelDevices,
  markModelDownloadComplete: mocks.markModelDownloadComplete,
  markModelDownloadStarted: mocks.markModelDownloadStarted,
}));

import { getPreset } from '../shared/models';
import { downloadTransformersModel, TransformersBackend } from './backends';

describe('downloadTransformersModel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.deleteModelCache.mockResolvedValue(0);
    mocks.getCompletedModelDevices.mockResolvedValue([]);
    mocks.markModelDownloadStarted.mockResolvedValue(undefined);
    mocks.markModelDownloadComplete.mockResolvedValue(undefined);
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
    mocks.getCompletedModelDevices.mockImplementation((modelId: string) =>
      Promise.resolve(modelId.endsWith('-OPT') ? [] : ['webgpu']),
    );
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
});
