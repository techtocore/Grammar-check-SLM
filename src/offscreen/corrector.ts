import { segmentSentences, splitLongSentence } from '../core/segment';
import { assembleCorrections } from '../core/corrections';
import { cleanModelOutput } from '../core/prompt';
import { LRUCache } from '../core/cache';
import type { Correction, Sentence } from '../core/types';
import type { ModelStatus, RunnerConfig } from '../shared/messages';
import { broadcastDownload } from '../shared/messages';
import { getPreset, MODEL_PRESETS } from '../shared/models';
import { createLogger } from '../shared/logger';
import { downloadTransformersModel, pickBackends, type Backend } from './backends';

const log = createLogger('runner');

// Bound how much text we run per request to keep latency reasonable.
const MAX_SENTENCE_LEN = 320;
const MAX_SENTENCES = 60;

// After a load failure, don't retry for this long (prevents a retry storm where
// every incoming check re-runs the whole failing load and thrashes memory).
const LOAD_RETRY_COOLDOWN_MS = 15000;

/** Turns a raw load error into a short, user-actionable message. */
function classifyError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (text.includes('could not locate') || text.includes('404') || text.includes('not found')) {
    return 'Model files could not be found. The model may be unavailable — try another model.';
  }
  if (
    text.includes('memory') ||
    text.includes('allocation') ||
    text.includes('array buffer') ||
    text.includes('oom') ||
    text.includes('aborted')
  ) {
    return 'Not enough memory to load this model. Pick a smaller model (e.g. Qwen3 0.6B) in Settings.';
  }
  if (
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('err_internet')
  ) {
    return 'Network error while downloading the model. Check your connection, then retry.';
  }
  if (text.includes('built-in') || text.includes('unavailable')) {
    return 'Chrome built-in AI is unavailable. Switch to a local model in Settings.';
  }
  if (text.includes('webgpu') || text.includes('gpu') || text.includes('adapter')) {
    return 'GPU initialization failed. Switch acceleration to CPU/WASM in Settings, then retry.';
  }
  return 'The model failed to load. Retry, or pick a different backend/model in Settings.';
}

/**
 * Orchestrates grammar checking on top of a pluggable {@link Backend} (Chrome
 * built-in AI or Transformers.js). Handles backend selection with fallback,
 * per-sentence memoisation, serialized access, status, and a load-failure
 * cooldown so failures can't turn into a retry storm.
 */
export class Corrector {
  private backend: Backend | null = null;
  private loadPromise: Promise<void> | null = null;
  private config: RunnerConfig | null = null;
  private loadGeneration = 0;
  private loadFailedAt = 0;
  private readonly cache = new LRUCache<string, string>(1000);
  private chain: Promise<unknown> = Promise.resolve();
  private status: ModelStatus = { state: 'idle', progress: 0, modelId: '', device: 'unknown' };

  constructor(private readonly onStatus: (status: ModelStatus) => void) {}

  getStatus(): ModelStatus {
    return this.status;
  }

  /** Updates preferences; reloads lazily if the backend/model/device changed. */
  setConfig(config: RunnerConfig): void {
    const changed =
      !this.config ||
      this.config.backend !== config.backend ||
      this.config.model !== config.model ||
      this.config.device !== config.device;
    this.config = config;
    if (changed) {
      this.loadFailedAt = 0;
      this.cache.clear();
      void this.dispose();
    }
  }

  async dispose(): Promise<void> {
    // Bump the generation up front so any in-flight load is invalidated and
    // knows it has been superseded (its progress/ready/error updates are
    // ignored from here on).
    const generation = ++this.loadGeneration;
    const backend = this.backend;
    this.backend = null;
    this.loadPromise = null;
    if (backend) {
      try {
        await backend.dispose();
      } catch {
        /* ignore */
      }
    }
    // Only fall back to "idle" if nothing newer has taken over while we were
    // tearing down. A slow teardown (e.g. GPU/WASM cleanup of a big model) can
    // otherwise clobber a freshly loaded model's "loading"/"ready" status and
    // leave the UI stuck on "idle" after a model switch.
    if (generation === this.loadGeneration) {
      this.setStatus({ state: 'idle', progress: 0 });
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.backend) return;
    if (this.loadFailedAt > 0 && Date.now() - this.loadFailedAt < LOAD_RETRY_COOLDOWN_MS) {
      throw new Error(this.status.message ?? 'Model failed to load');
    }
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  async correct(text: string): Promise<Correction[]> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const config = this.config;
      if (!config) return [];

      const sentences: Sentence[] = [];
      for (const sentence of segmentSentences(text, config.language)) {
        for (const chunk of splitLongSentence(sentence, MAX_SENTENCE_LEN)) {
          sentences.push(chunk);
          if (sentences.length >= MAX_SENTENCES) break;
        }
        if (sentences.length >= MAX_SENTENCES) break;
      }

      const corrected: string[] = [];
      for (const sentence of sentences) {
        corrected.push(await this.correctSentence(sentence.text));
      }
      const corrections = assembleCorrections(text, sentences, corrected);
      log.debug(`Corrected ${sentences.length} segment(s) → ${corrections.length} suggestion(s).`);
      return corrections;
    });
  }

  /** Disposes the current backend and loads it again (retry after an error). */
  async reload(): Promise<void> {
    return this.runExclusive(async () => {
      this.loadFailedAt = 0;
      await this.dispose();
      await this.ensureLoaded();
    });
  }

  /**
   * Downloads and caches a Transformers.js model's files without making it
   * active. Progress is broadcast per model.
   */
  async downloadModel(modelId: string): Promise<void> {
    const preset = MODEL_PRESETS.find((p) => p.modelId === modelId) ?? getPreset(modelId);
    if (!preset) throw new Error(`Unknown model: ${modelId}`);
    return this.runExclusive(async () => {
      broadcastDownload({ modelId: preset.modelId, state: 'downloading', progress: 0 });
      try {
        await downloadTransformersModel(preset, (progress) =>
          broadcastDownload({ modelId: preset.modelId, state: 'downloading', progress }),
        );
        broadcastDownload({ modelId: preset.modelId, state: 'done', progress: 100 });
      } catch (error) {
        broadcastDownload({
          modelId: preset.modelId,
          state: 'error',
          progress: 0,
          error: classifyError(error),
        });
        throw error;
      }
    });
  }

  private setStatus(patch: Partial<ModelStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  private async load(): Promise<void> {
    const config = this.config;
    if (!config) throw new Error('Runner is not configured');

    // Claim ownership of the status: this load now supersedes any earlier
    // teardown/load, so their late updates are ignored (see dispose()).
    const generation = ++this.loadGeneration;
    let lastError: unknown = new Error('No backend available');

    for (const makeBackend of pickBackends(config)) {
      if (generation !== this.loadGeneration) return; // superseded before we started
      const backend = makeBackend();
      this.setStatus({ state: 'loading', progress: 0 });
      try {
        const info = await backend.load(config, (progress, modelId, device) => {
          if (generation === this.loadGeneration) {
            this.setStatus({ state: 'loading', progress, modelId, device });
          }
        });
        if (generation !== this.loadGeneration) {
          await backend.dispose();
          return; // superseded by a config change
        }
        this.backend = backend;
        this.loadFailedAt = 0;
        this.setStatus({ state: 'ready', progress: 100, modelId: info.label, device: info.device });
        return;
      } catch (error) {
        lastError = error;
        log.warn('Backend load failed; trying the next option.', error);
        await backend.dispose().catch(() => undefined);
      }
    }

    if (generation === this.loadGeneration) this.failLoad(lastError);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private failLoad(error: unknown): void {
    this.loadPromise = null;
    this.loadFailedAt = Date.now();
    this.setStatus({
      state: 'error',
      progress: 0,
      error: error instanceof Error ? error.message : String(error),
      message: classifyError(error),
    });
  }

  private async correctSentence(sentence: string): Promise<string> {
    const cached = this.cache.get(sentence);
    if (cached !== undefined) return cached;

    const backend = this.backend;
    if (!backend) return sentence;

    let raw: string;
    try {
      raw = await backend.generate(sentence);
    } catch (error) {
      log.error('Generation failed for a sentence.', error);
      return sentence;
    }

    const cleaned = cleanModelOutput(raw, sentence);
    this.cache.set(sentence, cleaned);
    return cleaned;
  }

  /** Serializes access to the backend so requests never overlap. */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
