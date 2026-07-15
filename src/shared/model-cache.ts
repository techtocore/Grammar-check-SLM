// Inspects and manages the browser Cache API storage that Transformers.js uses
// for downloaded model files. The cache is origin-partitioned, so the service
// worker, offscreen document, and pages all share it.

import type { DevicePreference } from './models';

const CACHE_NAME = 'transformers-cache';
const MARKER_ROOT = '__grammar_slm_model_cache__';
type LocalDevice = Exclude<DevicePreference, 'auto'>;
const LOCAL_DEVICES: readonly LocalDevice[] = ['webgpu', 'wasm'];

export interface ModelCacheInfo {
  cached: boolean;
  partial: boolean;
}

function cacheStorage(): CacheStorage | null {
  return typeof caches !== 'undefined' ? caches : null;
}

function incompleteMarkerUrl(modelId: string): string {
  return `https://grammar-check-slm.invalid/${MARKER_ROOT}/${modelId}/incomplete`;
}

function deletingMarkerUrl(modelId: string): string {
  return `https://grammar-check-slm.invalid/${MARKER_ROOT}/${modelId}/deleting`;
}

function completeMarkerUrl(modelId: string, device: LocalDevice): string {
  return `https://grammar-check-slm.invalid/${MARKER_ROOT}/${modelId}/complete/${device}`;
}

function cacheInfoFromUrls(
  urls: readonly string[],
  modelId: string,
  devicePreference: DevicePreference,
): ModelCacheInfo {
  const needle = `/${modelId}/`;
  const weightUrls = urls.filter((url) => url.includes(needle) && url.includes('.onnx'));
  const hasWeights = weightUrls.length > 0;
  const deleting = urls.includes(deletingMarkerUrl(modelId));
  const partial = deleting || urls.includes(incompleteMarkerUrl(modelId));
  const webgpuComplete = urls.includes(completeMarkerUrl(modelId, 'webgpu'));
  const wasmComplete = urls.includes(completeMarkerUrl(modelId, 'wasm'));
  const hasCompletionMarker = webgpuComplete || wasmComplete;
  const selectedComplete =
    devicePreference === 'auto'
      ? hasCompletionMarker
      : devicePreference === 'webgpu'
        ? webgpuComplete
        : wasmComplete;
  return {
    cached: !deleting && hasWeights && selectedComplete,
    partial,
  };
}

async function openModelCache(): Promise<Cache> {
  const store = cacheStorage();
  if (!store) throw new Error('Browser model cache is unavailable.');
  return store.open(CACHE_NAME);
}

/** Returns concrete backends that have completed successfully for this model. */
export async function getCompletedModelDevices(modelId: string): Promise<LocalDevice[]> {
  const cache = await openModelCache();
  const urls = (await cache.keys()).map((request) => request.url);
  if (urls.includes(deletingMarkerUrl(modelId))) return [];
  return LOCAL_DEVICES.filter((device) => urls.includes(completeMarkerUrl(modelId, device)));
}

/** Marks a model download as in-progress so partial files are never reported as ready. */
export async function markModelDownloadStarted(
  modelId: string,
  devicePreference: DevicePreference,
): Promise<void> {
  const cache = await openModelCache();
  const urls = (await cache.keys()).map((request) => request.url);
  const recoveringDeletion = urls.includes(deletingMarkerUrl(modelId));
  const devicesToInvalidate =
    recoveringDeletion || devicePreference === 'auto' ? LOCAL_DEVICES : [devicePreference];

  await cache.put(incompleteMarkerUrl(modelId), new Response('incomplete'));
  await Promise.all(
    devicesToInvalidate.map((device) => cache.delete(completeMarkerUrl(modelId, device))),
  );
  await cache.delete(deletingMarkerUrl(modelId));
}

/** Records that every file needed by the model loaded successfully. */
export async function markModelDownloadComplete(
  modelId: string,
  device: LocalDevice,
): Promise<void> {
  const cache = await openModelCache();
  await cache.put(completeMarkerUrl(modelId, device), new Response('complete'));
  await cache.delete(incompleteMarkerUrl(modelId));
  await cache.delete(deletingMarkerUrl(modelId));
}

/** True if the given model's weights appear to be present in the cache. */
export async function isModelCached(
  modelId: string,
  devicePreference: DevicePreference = 'auto',
): Promise<boolean> {
  if (!modelId.trim()) return false;
  const store = cacheStorage();
  if (!store) return false;
  try {
    const cache = await store.open(CACHE_NAME);
    const urls = (await cache.keys()).map((request) => request.url);
    return cacheInfoFromUrls(urls, modelId, devicePreference).cached;
  } catch {
    return false;
  }
}

/** Returns cache readiness and partial-download state in a single cache scan. */
export async function listModelCacheInfo(
  modelIds: string[],
  devicePreference: DevicePreference = 'auto',
): Promise<Record<string, ModelCacheInfo>> {
  const result: Record<string, ModelCacheInfo> = {};
  for (const id of modelIds) result[id] = { cached: false, partial: false };
  const store = cacheStorage();
  if (!store) return result;
  try {
    const cache = await store.open(CACHE_NAME);
    const urls = (await cache.keys()).map((req) => req.url);
    for (const id of modelIds) {
      result[id] = cacheInfoFromUrls(urls, id, devicePreference);
    }
  } catch {
    /* ignore */
  }
  return result;
}

/** Returns a map of modelId → cached for callers that do not need partial state. */
export async function listCachedModels(
  modelIds: string[],
  devicePreference: DevicePreference = 'auto',
): Promise<Record<string, boolean>> {
  const info = await listModelCacheInfo(modelIds, devicePreference);
  return Object.fromEntries(modelIds.map((id) => [id, info[id]?.cached ?? false]));
}

/** Deletes all cached files for a model. Returns the number of entries removed. */
export async function deleteModelCache(modelId: string): Promise<number> {
  if (!modelId.trim()) return 0;
  const store = cacheStorage();
  if (!store) return 0;
  const cache = await store.open(CACHE_NAME);
  const deletingMarker = deletingMarkerUrl(modelId);
  await cache.put(deletingMarker, new Response('deleting'));
  const keys = await cache.keys();
  const needle = `/${modelId}/`;
  let deleted = 0;
  for (const req of keys) {
    if (req.url !== deletingMarker && req.url.includes(needle) && (await cache.delete(req))) {
      deleted++;
    }
  }
  const remaining = (await cache.keys()).some(
    (request) => request.url !== deletingMarker && request.url.includes(needle),
  );
  if (remaining) throw new Error('Some local model files could not be deleted.');
  await cache.delete(deletingMarker);
  return deleted;
}
