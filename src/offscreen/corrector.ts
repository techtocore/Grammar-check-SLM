import { segmentSentences, splitLongSentence } from '../core/segment';
import { assembleCorrections } from '../core/corrections';
import { cleanModelOutput } from '../core/prompt';
import { LRUCache } from '../core/cache';
import type { Correction, Sentence } from '../core/types';
import type { ModelDownloadStatus, ModelStatus, RunnerConfig } from '../shared/messages';
import { broadcastDownload } from '../shared/messages';
import { getPreset, MODEL_PRESETS, resolvePreset } from '../shared/models';
import { createLogger } from '../shared/logger';
import { deleteModelCache } from '../shared/model-cache';
import { downloadTransformersModel, pickBackends, type Backend } from './backends';

const log = createLogger('runner');

// Bound how much text we run per request to keep latency reasonable.
const MAX_SENTENCE_LEN = 320;
const MAX_SENTENCES = 60;

// After a load failure, don't retry for this long (prevents a retry storm where
// every incoming check re-runs the whole failing load and thrashes memory).
const LOAD_RETRY_COOLDOWN_MS = 15000;

interface DownloadOperation {
  modelId: string;
  purpose?: 'onboarding';
  promise: Promise<void>;
}

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
  if (text.includes('model cache') || text.includes('cache storage')) {
    return 'Browser storage is unavailable for the local model. Free storage, then retry.';
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
  private readonly downloadStatuses = new Map<string, ModelDownloadStatus>();
  private readonly downloadStatusOwners = new Map<string, string>();
  private readonly downloadOperations = new Map<string, DownloadOperation>();
  private readonly runningDownloadKeys = new Set<string>();
  private readonly adoptedOnboardingKeys = new Set<string>();
  private onboardingTarget: { modelId: string; device: RunnerConfig['device'] } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private status: ModelStatus = { state: 'idle', progress: 0, modelId: '', device: 'unknown' };

  constructor(
    private readonly onStatus: (status: ModelStatus) => void,
    private readonly backendPicker: typeof pickBackends = pickBackends,
  ) {}

  getStatus(): ModelStatus {
    return this.status;
  }

  getDownloadStatuses(): ModelDownloadStatus[] {
    return [...this.downloadStatuses.values()].map((status) => ({ ...status }));
  }

  selectOnboardingTarget(
    modelId: string,
    device: RunnerConfig['device'],
  ): {
    hasMatchingRunning: boolean;
    hasObsoleteRunning: boolean;
    hasMatchingRunnerLoading: boolean;
    hasObsoleteRunnerLoading: boolean;
    clearedObsoleteStatus: boolean;
  } {
    const preset = MODEL_PRESETS.find((candidate) => candidate.modelId === modelId);
    if (!preset) throw new Error(`Unknown model: ${modelId}`);

    this.onboardingTarget = { modelId: preset.modelId, device };
    const matchingKey = `${preset.modelId}\u0000${device}`;
    const matching = this.downloadOperations.get(matchingKey);
    const previousOwner = this.downloadStatusOwners.get(preset.modelId);
    const clearedObsoleteStatus =
      !matching && previousOwner !== undefined && previousOwner !== matchingKey;
    if (clearedObsoleteStatus) {
      this.downloadStatusOwners.delete(preset.modelId);
      this.downloadStatuses.delete(preset.modelId);
      broadcastDownload({ modelId: preset.modelId, state: 'cancelled', progress: 0 });
    }
    if (matching) {
      matching.purpose = 'onboarding';
      this.adoptedOnboardingKeys.add(matchingKey);
      this.downloadStatusOwners.set(preset.modelId, matchingKey);
      this.setDownloadStatus(matchingKey, {
        modelId: preset.modelId,
        state: 'downloading',
        progress: 0,
      });
    }

    const runningDownloads = [...this.downloadOperations.entries()].filter(([key]) =>
      this.runningDownloadKeys.has(key),
    );
    const runnerLoading = this.runnerLoadingRelation(preset.modelId, device);
    return {
      hasMatchingRunning: this.runningDownloadKeys.has(matchingKey),
      hasObsoleteRunning: runningDownloads.some(([key]) => key !== matchingKey),
      hasMatchingRunnerLoading: runnerLoading === 'matching',
      hasObsoleteRunnerLoading: runnerLoading === 'obsolete',
      clearedObsoleteStatus,
    };
  }

  /** Updates preferences after any active inference finishes; reloads lazily. */
  setConfig(config: RunnerConfig): Promise<void> {
    return this.runExclusive(async () => {
      const prev = this.config;
      const coreChanged =
        !prev ||
        prev.backend !== config.backend ||
        prev.model !== config.model ||
        prev.device !== config.device;
      // The Chrome Prompt API bakes the language into the session at load time,
      // so a language change needs a session rebuild. Transformers reads the
      // language per request and can keep its loaded weights.
      const languageChanged = !!prev && prev.language !== config.language;
      const needsReload = coreChanged || (languageChanged && this.status.device === 'built-in');
      this.config = config;
      if (needsReload) {
        this.loadFailedAt = 0;
        this.cache.clear();
        await this.dispose();
      }
    });
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
      this.setStatus({
        state: 'idle',
        progress: 0,
        modelId: '',
        device: 'unknown',
        error: undefined,
        message: undefined,
      });
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

  /** Loads the configured backend through the same queue as checks/downloads. */
  warmup(): Promise<void> {
    return this.runExclusive(() => this.ensureLoaded());
  }

  /** Releases model memory after queued inference/download work has completed. */
  suspend(): Promise<void> {
    return this.runExclusive(() => this.dispose());
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
      const corrections = assembleCorrections(text, sentences, corrected, {
        locale: config.language,
      });
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
  downloadModel(
    modelId: string,
    devicePreference: RunnerConfig['device'],
    purpose?: 'onboarding',
  ): Promise<void> {
    const preset = MODEL_PRESETS.find((p) => p.modelId === modelId) ?? getPreset(modelId);
    if (!preset) return Promise.reject(new Error(`Unknown model: ${modelId}`));

    if (purpose === 'onboarding') {
      this.onboardingTarget = { modelId: preset.modelId, device: devicePreference };
      this.adoptedOnboardingKeys.add(`${preset.modelId}\u0000${devicePreference}`);
    }
    const operationKey = `${preset.modelId}\u0000${devicePreference}`;
    const existing = this.downloadOperations.get(operationKey);
    if (existing) {
      if (purpose === 'onboarding') {
        this.downloadStatusOwners.set(preset.modelId, operationKey);
        this.setDownloadStatus(operationKey, {
          modelId: preset.modelId,
          state: 'downloading',
          progress: 0,
        });
      }
      return existing.promise;
    }

    this.downloadStatusOwners.set(preset.modelId, operationKey);
    this.setDownloadStatus(operationKey, {
      modelId: preset.modelId,
      state: 'downloading',
      progress: 0,
    });
    const operation = this.runExclusive(async () => {
      this.runningDownloadKeys.add(operationKey);
      try {
        if (
          this.isOnboardingOperation(operationKey, purpose) &&
          !this.isCurrentOnboardingTarget(preset.modelId, devicePreference)
        ) {
          this.clearDownloadStatus(operationKey, preset.modelId, true);
          return;
        }
        await this.dispose();
        if (
          this.isOnboardingOperation(operationKey, purpose) &&
          !this.isCurrentOnboardingTarget(preset.modelId, devicePreference)
        ) {
          this.clearDownloadStatus(operationKey, preset.modelId, true);
          return;
        }
        try {
          await downloadTransformersModel(
            preset,
            (progress) => {
              if (
                !this.isOnboardingOperation(operationKey, purpose) ||
                this.isCurrentOnboardingTarget(preset.modelId, devicePreference)
              ) {
                this.setDownloadStatus(operationKey, {
                  modelId: preset.modelId,
                  state: 'downloading',
                  progress: Math.min(99, Math.max(0, Math.round(progress))),
                });
              }
            },
            devicePreference,
          );
          if (
            !this.isOnboardingOperation(operationKey, purpose) ||
            this.isCurrentOnboardingTarget(preset.modelId, devicePreference)
          ) {
            if (this.downloadStatusOwners.get(preset.modelId) === operationKey) {
              this.clearDownloadStatus(operationKey, preset.modelId);
              broadcastDownload({ modelId: preset.modelId, state: 'done', progress: 100 });
            }
          } else {
            this.clearDownloadStatus(operationKey, preset.modelId, true);
          }
        } catch (error) {
          if (
            !this.isOnboardingOperation(operationKey, purpose) ||
            this.isCurrentOnboardingTarget(preset.modelId, devicePreference)
          ) {
            this.setDownloadStatus(operationKey, {
              modelId: preset.modelId,
              state: 'error',
              progress: 0,
              error: classifyError(error),
            });
          } else {
            this.clearDownloadStatus(operationKey, preset.modelId, true);
          }
          throw error;
        }
      } finally {
        this.runningDownloadKeys.delete(operationKey);
      }
    });
    const entry: DownloadOperation = { modelId: preset.modelId, purpose, promise: operation };
    this.downloadOperations.set(operationKey, entry);
    void operation.then(
      () => {
        if (this.downloadOperations.get(operationKey) === entry) {
          this.downloadOperations.delete(operationKey);
          this.adoptedOnboardingKeys.delete(operationKey);
        }
      },
      () => {
        if (this.downloadOperations.get(operationKey) === entry) {
          this.downloadOperations.delete(operationKey);
          this.adoptedOnboardingKeys.delete(operationKey);
        }
      },
    );
    return operation;
  }

  /** Deletes a model through the same queue used for downloads and inference. */
  deleteModel(modelId: string): Promise<number> {
    const preset = MODEL_PRESETS.find((candidate) => candidate.modelId === modelId);
    if (!preset) return Promise.reject(new Error(`Unknown model: ${modelId}`));
    if (
      [...this.downloadOperations.values()].some(
        (operation) => operation.modelId === preset.modelId,
      )
    ) {
      return Promise.reject(new Error('Wait for the active download to finish.'));
    }

    this.downloadStatusOwners.delete(preset.modelId);
    this.downloadStatuses.delete(preset.modelId);
    return this.runExclusive(() => deleteModelCache(preset.modelId));
  }

  private isCurrentOnboardingTarget(modelId: string, device: RunnerConfig['device']): boolean {
    return this.onboardingTarget?.modelId === modelId && this.onboardingTarget.device === device;
  }

  private isOnboardingOperation(operationKey: string, purpose?: 'onboarding'): boolean {
    return purpose === 'onboarding' || this.adoptedOnboardingKeys.has(operationKey);
  }

  private runnerLoadingRelation(
    modelId: string,
    device: RunnerConfig['device'],
  ): 'matching' | 'obsolete' | 'none' {
    if (this.status.state !== 'loading' || this.status.device === 'built-in') return 'none';
    const config = this.config;
    if (!config || config.backend === 'prompt') return 'none';
    const concreteDevice =
      this.status.device === 'webgpu' || this.status.device === 'wasm'
        ? this.status.device
        : config.device;
    const configuredModel =
      this.status.modelId || resolvePreset(config.model, concreteDevice !== 'wasm').modelId;
    const deviceMatches =
      device === 'auto' ||
      concreteDevice === device ||
      (concreteDevice === 'auto' && config.device === device);
    return configuredModel === modelId && deviceMatches ? 'matching' : 'obsolete';
  }

  private clearDownloadStatus(operationKey: string, modelId: string, cancelled = false): void {
    if (this.downloadStatusOwners.get(modelId) !== operationKey) return;
    this.downloadStatusOwners.delete(modelId);
    this.downloadStatuses.delete(modelId);
    if (cancelled) {
      broadcastDownload({ modelId, state: 'cancelled', progress: 0 });
    }
  }

  private setDownloadStatus(operationKey: string, status: ModelDownloadStatus): void {
    if (this.downloadStatusOwners.get(status.modelId) !== operationKey) return;
    this.downloadStatuses.set(status.modelId, status);
    broadcastDownload(status);
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

    for (const makeBackend of this.backendPicker(config)) {
      if (generation !== this.loadGeneration) return; // superseded before we started
      const backend = makeBackend();
      this.setStatus({
        state: 'loading',
        progress: 0,
        modelId: '',
        device: 'unknown',
        error: undefined,
        message: undefined,
      });
      try {
        const info = await backend.load(config, (progress, modelId, device) => {
          if (generation === this.loadGeneration) {
            this.setStatus({
              state: 'loading',
              progress,
              modelId,
              device,
              error: undefined,
              message: undefined,
            });
          }
        });
        if (generation !== this.loadGeneration) {
          await backend.dispose();
          return; // superseded by a config change
        }
        this.backend = backend;
        this.loadFailedAt = 0;
        this.setStatus({
          state: 'ready',
          progress: 100,
          modelId: info.modelId,
          device: info.device,
          error: undefined,
          message: undefined,
        });
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

    const raw = await backend.generate(sentence);

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
