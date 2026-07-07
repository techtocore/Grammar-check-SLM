import { pipeline, env } from '@huggingface/transformers';

import { segmentSentences, splitLongSentence } from '../core/segment';
import { assembleCorrections } from '../core/corrections';
import { buildMessages, buildT5Prompt, cleanModelOutput } from '../core/prompt';
import { LRUCache } from '../core/cache';
import type { Correction, Sentence } from '../core/types';
import type { ModelStatus, RunnerConfig } from '../shared/messages';
import { broadcastDownload } from '../shared/messages';
import {
  getPreset,
  resolvePreset,
  MODEL_PRESETS,
  type DType,
  type ModelPreset,
} from '../shared/models';
import { createLogger } from '../shared/logger';

const log = createLogger('runner');

// Bound how much text we run per request to keep latency reasonable.
const MAX_SENTENCE_LEN = 320;
const MAX_SENTENCES = 60;

// After a load failure, don't retry for this long (prevents a retry storm where
// every incoming check re-runs the whole failing load and thrashes memory).
const LOAD_RETRY_COOLDOWN_MS = 15000;

// ---- Configure Transformers.js for the extension environment (once) ----
env.allowLocalModels = false;
env.useBrowserCache = true;
const onnxWasm = env.backends?.onnx?.wasm as
  { wasmPaths?: string; numThreads?: number; proxy?: boolean } | undefined;
if (onnxWasm) {
  // Serve the ONNX Runtime binaries from the bundled copy (CSP-safe, offline-capable).
  onnxWasm.wasmPaths = chrome.runtime.getURL('ort/');
  // Extension pages are not cross-origin isolated -> no SharedArrayBuffer/threads/worker proxy.
  onnxWasm.numThreads = 1;
  onnxWasm.proxy = false;
}

type ChatTurn = { role: string; content: string };
interface GenerationOutputItem {
  generated_text?: string | ChatTurn[];
}
interface TextGenerator {
  (input: string, options?: Record<string, unknown>): Promise<GenerationOutputItem[]>;
  tokenizer: {
    apply_chat_template(messages: unknown, options: Record<string, unknown>): string;
  };
  dispose?(): Promise<void>;
}

const createPipeline = pipeline as unknown as (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<TextGenerator>;

async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/** Ordered list of backends to try for a given preference. */
function deviceCandidates(pref: RunnerConfig['device'], hasWebGPU: boolean): ('webgpu' | 'wasm')[] {
  if (pref === 'wasm') return ['wasm'];
  return hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
}

/** Ordered list of quantizations to try for a given backend (preferred first). */
function dtypeCandidates(preset: ModelPreset, device: 'webgpu' | 'wasm'): DType[] {
  if (preset.task === 'text2text-generation') {
    // Small encoder-decoder models: preferred dtype plus a light fallback.
    return [...new Set<DType>([preset.dtype[device], device === 'webgpu' ? 'fp16' : 'q8', 'q8'])];
  }
  // Causal LMs can be large — only try memory-frugal quantizations, ordered from
  // lowest to higher memory. Never fall back to fp16/fp32, which would only make
  // an out-of-memory failure worse.
  const fallbacks: DType[] = device === 'webgpu' ? ['q4f16', 'q4', 'q8'] : ['q4', 'q8'];
  return [...new Set<DType>([preset.dtype[device], ...fallbacks])];
}

/** Whether an error looks like an out-of-memory / allocation failure. */
function isMemoryError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('memory') ||
    text.includes('allocation') ||
    text.includes('array buffer') ||
    text.includes('oom') ||
    text.includes('aborted')
  );
}

interface RawProgress {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

/**
 * Aggregates per-file download progress into a single, monotonic 0–99% value.
 * A model download fetches several files (config, tokenizer, weights); reporting
 * each file's own 0→100% makes the bar jump backwards, so we combine them by
 * bytes and anchor the denominator to the expected total to avoid tiny early
 * files spiking to 100%.
 */
class ProgressAggregator {
  private readonly files = new Map<string, { loaded: number; total: number }>();
  private max = 0;

  constructor(private readonly expectedBytes: number) {}

  update(raw: RawProgress): number {
    const file = raw.file ?? '';
    if (file) {
      const prev = this.files.get(file) ?? { loaded: 0, total: 0 };
      const loaded = typeof raw.loaded === 'number' ? raw.loaded : prev.loaded;
      const total = typeof raw.total === 'number' && raw.total > 0 ? raw.total : prev.total;
      if (raw.status === 'done') {
        // A completed file counts fully towards the total.
        const size = Math.max(total, loaded, prev.loaded, prev.total);
        this.files.set(file, { loaded: size, total: size });
      } else {
        this.files.set(file, { loaded, total });
      }
    }

    let sumLoaded = 0;
    let sumTotal = 0;
    for (const entry of this.files.values()) {
      sumLoaded += entry.loaded;
      sumTotal += Math.max(entry.total, entry.loaded);
    }
    const denom = Math.max(sumTotal, this.expectedBytes, 1);
    const pct = Math.min(99, Math.round((sumLoaded / denom) * 100));
    this.max = Math.max(this.max, pct);
    return this.max;
  }
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
  if (text.includes('webgpu') || text.includes('gpu') || text.includes('adapter')) {
    return 'GPU initialization failed. Switch acceleration to CPU/WASM in Settings, then retry.';
  }
  return 'The model failed to load. Retry, or pick a different model in Settings.';
}

function extractText(out: GenerationOutputItem[]): string {
  const first = out[0];
  const gen = first?.generated_text;
  if (typeof gen === 'string') return gen;
  if (Array.isArray(gen)) {
    const last = gen[gen.length - 1];
    if (last && typeof last.content === 'string') return last.content;
  }
  return '';
}

/**
 * Loads and drives a local SLM to produce grammar corrections. Handles model
 * resolution, device selection (WebGPU with WASM fallback), per-sentence
 * generation, memoisation, and serialized access to the ONNX session.
 */
export class Corrector {
  private generator: TextGenerator | null = null;
  private preset: ModelPreset | null = null;
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

  /** Updates preferences; reloads the model lazily if the model/device changed. */
  setConfig(config: RunnerConfig): void {
    const changed =
      !this.config || this.config.model !== config.model || this.config.device !== config.device;
    this.config = config;
    if (changed) {
      // Invalidate any in-flight load so its result is discarded on completion.
      this.loadGeneration++;
      this.loadFailedAt = 0;
      this.cache.clear();
      void this.dispose();
    }
  }

  async dispose(): Promise<void> {
    const gen = this.generator;
    this.generator = null;
    this.preset = null;
    this.loadPromise = null;
    if (gen?.dispose) {
      try {
        await gen.dispose();
      } catch {
        /* ignore */
      }
    }
    this.setStatus({ state: 'idle', progress: 0 });
  }

  async ensureLoaded(): Promise<void> {
    if (this.generator) return;
    // Fail fast during the cooldown after a failure, instead of re-running the
    // whole (memory-thrashing) load gauntlet on every incoming request.
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
      const preset = this.preset;
      if (!config || !preset) return [];

      // Split any over-long/unpunctuated segments so nothing is silently skipped.
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
        corrected.push(await this.correctSentence(sentence.text, preset));
      }
      const corrections = assembleCorrections(text, sentences, corrected);
      log.debug(`Corrected ${sentences.length} segment(s) → ${corrections.length} suggestion(s).`);
      return corrections;
    });
  }

  private setStatus(patch: Partial<ModelStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  private async load(): Promise<void> {
    const config = this.config;
    if (!config) throw new Error('Runner is not configured');

    const generation = this.loadGeneration;
    const hasWebGPU = await detectWebGPU();
    if (config.device === 'webgpu' && !hasWebGPU) {
      log.warn('WebGPU requested but unavailable; falling back to WASM.');
    }
    const preset = resolvePreset(config.model, hasWebGPU);
    const expectedBytes = preset.approxDownloadMB * 1024 * 1024;
    let lastError: unknown = new Error('No backend available');

    // Try each backend, and within each, each quantization, until one loads.
    for (const device of deviceCandidates(config.device, hasWebGPU)) {
      for (const dtype of dtypeCandidates(preset, device)) {
        if (generation !== this.loadGeneration) return; // superseded by a config change
        this.setStatus({ state: 'loading', progress: 0, modelId: preset.modelId, device });
        const aggregator = new ProgressAggregator(expectedBytes);
        try {
          const generator = await this.build(preset, device, dtype, (raw) => {
            if (raw.status === 'progress' || raw.status === 'done') {
              this.setStatus({ state: 'loading', progress: aggregator.update(raw) });
            }
          });
          if (generation !== this.loadGeneration) {
            await generator.dispose?.();
            return;
          }
          this.generator = generator;
          this.preset = preset;
          this.loadFailedAt = 0;
          this.setStatus({ state: 'ready', progress: 100, device });
          return;
        } catch (error) {
          lastError = error;
          log.warn(`Load failed on ${device}/${dtype}.`, error);
          // A different quantization of the SAME model won't fix an out-of-memory
          // error (and only allocates more), so skip to the next backend.
          if (isMemoryError(error)) break;
        }
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

  private async build(
    preset: ModelPreset,
    device: 'webgpu' | 'wasm',
    dtype: DType,
    onProgress: (raw: RawProgress) => void,
  ): Promise<TextGenerator> {
    const progress_callback = (raw: unknown): void => {
      onProgress(raw as RawProgress);
    };
    log.info(`Loading ${preset.modelId} on ${device} (${dtype}).`);
    return createPipeline(preset.task, preset.modelId, { device, dtype, progress_callback });
  }

  /** Disposes the current model and loads it again (used for retry after an error). */
  async reload(): Promise<void> {
    // Invalidate any in-flight load so it can't complete alongside the retry.
    this.loadGeneration++;
    this.loadFailedAt = 0;
    await this.dispose();
    await this.ensureLoaded();
  }

  /**
   * Downloads and caches a model's files without making it active, by loading a
   * throwaway pipeline and disposing it. Progress is broadcast per model.
   */
  async downloadModel(modelId: string): Promise<void> {
    const preset = MODEL_PRESETS.find((p) => p.modelId === modelId) ?? getPreset(modelId);
    if (!preset) throw new Error(`Unknown model: ${modelId}`);
    return this.runExclusive(async () => {
      const hasWebGPU = await detectWebGPU();
      const expectedBytes = preset.approxDownloadMB * 1024 * 1024;
      let lastError: unknown = new Error('No backend available');
      broadcastDownload({ modelId: preset.modelId, state: 'downloading', progress: 0 });
      for (const device of deviceCandidates('auto', hasWebGPU)) {
        for (const dtype of dtypeCandidates(preset, device)) {
          const aggregator = new ProgressAggregator(expectedBytes);
          try {
            const generator = await this.build(preset, device, dtype, (raw) => {
              if (raw.status === 'progress' || raw.status === 'done') {
                broadcastDownload({
                  modelId: preset.modelId,
                  state: 'downloading',
                  progress: aggregator.update(raw),
                });
              }
            });
            await generator.dispose?.();
            broadcastDownload({ modelId: preset.modelId, state: 'done', progress: 100 });
            return;
          } catch (error) {
            lastError = error;
            log.warn(`Download failed on ${device}/${dtype}.`, error);
          }
        }
      }
      broadcastDownload({
        modelId: preset.modelId,
        state: 'error',
        progress: 0,
        error: classifyError(lastError),
      });
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    });
  }

  private async correctSentence(sentence: string, preset: ModelPreset): Promise<string> {
    const cached = this.cache.get(sentence);
    if (cached !== undefined) return cached;

    const generator = this.generator;
    if (!generator) return sentence;

    const maxNewTokens = Math.min(256, Math.max(32, Math.round(sentence.length / 2) + 24));
    let raw = '';
    try {
      if (preset.task === 'text-generation') {
        const prompt = generator.tokenizer.apply_chat_template(buildMessages(sentence), {
          tokenize: false,
          add_generation_prompt: true,
          enable_thinking: false,
        });
        const output = await generator(prompt, {
          max_new_tokens: maxNewTokens,
          do_sample: false,
          repetition_penalty: 1.05,
          return_full_text: false,
        });
        raw = extractText(output);
      } else {
        const output = await generator(buildT5Prompt(sentence), { max_new_tokens: maxNewTokens });
        raw = extractText(output);
      }
    } catch (error) {
      log.error('Generation failed for a sentence.', error);
      return sentence;
    }

    const cleaned = cleanModelOutput(raw, sentence);
    this.cache.set(sentence, cleaned);
    return cleaned;
  }

  /** Serializes access to the single ONNX session so requests never overlap. */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
