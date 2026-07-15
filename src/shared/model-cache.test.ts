import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteModelCache,
  getCompletedModelDevices,
  listCachedModels,
  listModelCacheInfo,
  markModelDownloadComplete,
  markModelDownloadStarted,
} from './model-cache';

const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';

describe('model cache completion markers', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('does not report partial downloads as cached', async () => {
    const urls = new Set([`https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_q4.onnx`]);
    const requestUrl = (request: RequestInfo | URL): string => {
      if (typeof request === 'string') return request;
      if ('url' in request) return request.url;
      return request.toString();
    };
    const cache = {
      keys: vi.fn(() => Promise.resolve([...urls].map((url) => ({ url })))),
      delete: vi.fn((request: RequestInfo | URL) =>
        Promise.resolve(urls.delete(requestUrl(request))),
      ),
      put: vi.fn((request: RequestInfo | URL) => {
        urls.add(requestUrl(request));
        return Promise.resolve();
      }),
    };
    vi.stubGlobal('caches', {
      open: vi.fn(() => Promise.resolve(cache)),
    });

    await expect(listCachedModels([MODEL_ID])).resolves.toEqual({ [MODEL_ID]: false });

    await markModelDownloadStarted(MODEL_ID, 'wasm');
    await expect(listModelCacheInfo([MODEL_ID], 'wasm')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: true },
    });

    await markModelDownloadComplete(MODEL_ID, 'wasm');
    await expect(listModelCacheInfo([MODEL_ID], 'wasm')).resolves.toEqual({
      [MODEL_ID]: { cached: true, partial: false },
    });
    await expect(getCompletedModelDevices(MODEL_ID)).resolves.toEqual(['wasm']);
    await expect(listModelCacheInfo([MODEL_ID], 'auto')).resolves.toEqual({
      [MODEL_ID]: { cached: true, partial: false },
    });
    await expect(listModelCacheInfo([MODEL_ID], 'webgpu')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: false },
    });

    await deleteModelCache(MODEL_ID);
    await expect(listModelCacheInfo([MODEL_ID], 'wasm')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: false },
    });
    await expect(listModelCacheInfo([MODEL_ID], 'auto')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: false },
    });
  });

  it('keeps a tombstone when deletion is interrupted', async () => {
    const urls = new Set([`https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_q4.onnx`]);
    let failDeletion = true;
    const requestUrl = (request: RequestInfo | URL): string => {
      if (typeof request === 'string') return request;
      if ('url' in request) return request.url;
      return request.toString();
    };
    const cache = {
      keys: vi.fn(() => Promise.resolve([...urls].map((url) => ({ url })))),
      delete: vi.fn((request: RequestInfo | URL) => {
        const url = requestUrl(request);
        if (failDeletion && url.includes('.onnx')) {
          return Promise.reject(new Error('cache deletion interrupted'));
        }
        return Promise.resolve(urls.delete(url));
      }),
      put: vi.fn((request: RequestInfo | URL) => {
        urls.add(requestUrl(request));
        return Promise.resolve();
      }),
    };
    vi.stubGlobal('caches', {
      open: vi.fn(() => Promise.resolve(cache)),
    });

    await markModelDownloadComplete(MODEL_ID, 'wasm');
    await expect(deleteModelCache(MODEL_ID)).rejects.toThrow('cache deletion interrupted');
    await expect(listModelCacheInfo([MODEL_ID], 'wasm')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: true },
    });

    await markModelDownloadStarted(MODEL_ID, 'wasm');
    await expect(listModelCacheInfo([MODEL_ID], 'wasm')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: true },
    });

    failDeletion = false;
    await deleteModelCache(MODEL_ID);
    await expect(listModelCacheInfo([MODEL_ID], 'wasm')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: false },
    });
  });

  it('does not use a WebGPU-only cache when only WASM is available', async () => {
    const urls = new Set([`https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_q4f16.onnx`]);
    const requestUrl = (request: RequestInfo | URL): string => {
      if (typeof request === 'string') return request;
      if ('url' in request) return request.url;
      return request.toString();
    };
    const cache = {
      keys: vi.fn(() => Promise.resolve([...urls].map((url) => ({ url })))),
      delete: vi.fn((request: RequestInfo | URL) =>
        Promise.resolve(urls.delete(requestUrl(request))),
      ),
      put: vi.fn((request: RequestInfo | URL) => {
        urls.add(requestUrl(request));
        return Promise.resolve();
      }),
    };
    vi.stubGlobal('caches', {
      open: vi.fn(() => Promise.resolve(cache)),
    });

    await expect(listModelCacheInfo([MODEL_ID], 'wasm')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: false },
    });
    await markModelDownloadComplete(MODEL_ID, 'webgpu');
    await expect(listModelCacheInfo([MODEL_ID], 'auto')).resolves.toEqual({
      [MODEL_ID]: { cached: true, partial: false },
    });
    await expect(listModelCacheInfo([MODEL_ID], 'wasm')).resolves.toEqual({
      [MODEL_ID]: { cached: false, partial: false },
    });
  });
});
