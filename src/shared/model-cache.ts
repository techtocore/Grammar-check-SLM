// Inspects and manages the browser Cache API storage that Transformers.js uses
// for downloaded model files. The cache is origin-partitioned, so the service
// worker, offscreen document, and pages all share it.

const CACHE_NAME = 'transformers-cache';

function cacheStorage(): CacheStorage | null {
  return typeof caches !== 'undefined' ? caches : null;
}

/** True if the given model's weights appear to be present in the cache. */
export async function isModelCached(modelId: string): Promise<boolean> {
  const store = cacheStorage();
  if (!store) return false;
  try {
    const cache = await store.open(CACHE_NAME);
    const keys = await cache.keys();
    const needle = `/${modelId}/`;
    return keys.some((req) => req.url.includes(needle) && req.url.includes('.onnx'));
  } catch {
    return false;
  }
}

/** Returns a map of modelId → cached for the given ids (single cache scan). */
export async function listCachedModels(modelIds: string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const id of modelIds) result[id] = false;
  const store = cacheStorage();
  if (!store) return result;
  try {
    const cache = await store.open(CACHE_NAME);
    const urls = (await cache.keys()).map((req) => req.url);
    for (const id of modelIds) {
      const needle = `/${id}/`;
      result[id] = urls.some((url) => url.includes(needle) && url.includes('.onnx'));
    }
  } catch {
    /* ignore */
  }
  return result;
}

/** Deletes all cached files for a model. Returns the number of entries removed. */
export async function deleteModelCache(modelId: string): Promise<number> {
  const store = cacheStorage();
  if (!store) return 0;
  try {
    const cache = await store.open(CACHE_NAME);
    const keys = await cache.keys();
    const needle = `/${modelId}/`;
    let deleted = 0;
    for (const req of keys) {
      if (req.url.includes(needle) && (await cache.delete(req))) deleted++;
    }
    return deleted;
  } catch {
    return 0;
  }
}
