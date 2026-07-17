import { pipeline, env } from '@huggingface/transformers';

import { buildMessages, buildT5Prompt, buildInitialPrompts } from '../core/prompt';
import {
  getPreset,
  resolvePreset,
  MODEL_PRESETS,
  type DType,
  type DTypeConfig,
  type ModelPreset,
} from '../shared/models';
import type { ModelStatus, RunnerConfig } from '../shared/messages';
import { createLogger } from '../shared/logger';
import { promptApiLanguageOptions } from '../shared/prompt-language';
import {
  getCompletedModelDevices,
  markModelDownloadComplete,
  markModelDownloadStarted,
} from '../shared/model-cache';

const log = createLogger('backend');

// ---- Configure Transformers.js for the extension environment (once) ----
env.allowLocalModels = false;
env.useBrowserCache = true;
const onnxWasm = env.backends?.onnx?.wasm as
  { wasmPaths?: string; numThreads?: number; proxy?: boolean } | undefined;
if (onnxWasm) {
  onnxWasm.wasmPaths = chrome.runtime.getURL('ort/');
  onnxWasm.numThreads = 1;
  onnxWasm.proxy = false;
}

type Device = ModelStatus['device'];

export interface LoadedBackend {
  label: string;
  modelId: string;
  device: Device;
}

export type ProgressFn = (progress: number, modelId: string, device: Device) => void;

/** A pluggable inference backend used by the Corrector. */
export interface Backend {
  load(config: RunnerConfig, onProgress: ProgressFn): Promise<LoadedBackend>;
  /** Returns the raw model output for one sentence (cleanup happens in the Corrector). */
  generate(sentence: string): Promise<string>;
  dispose(): Promise<void>;
}

// =====================================================================
// Transformers.js machinery
// =====================================================================

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

export async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

function deviceCandidates(pref: RunnerConfig['device'], hasWebGPU: boolean): ('webgpu' | 'wasm')[] {
  if (pref === 'wasm') return ['wasm'];
  if (pref === 'webgpu') return ['webgpu'];
  return hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
}

async function orderedDeviceCandidates(
  pref: RunnerConfig['device'],
  hasWebGPU: boolean,
  preset: ModelPreset,
): Promise<('webgpu' | 'wasm')[]> {
  const candidates = deviceCandidates(pref, hasWebGPU).filter(
    (device) => !preset.requiresWebGPU || device === 'webgpu',
  );
  if (pref !== 'auto') return candidates;
  const completed = new Set(
    await getCompletedModelDevices(preset.modelId).catch((error: unknown) => {
      log.warn('Could not inspect cached model backends.', error);
      return [];
    }),
  );
  return [
    ...candidates.filter((device) => completed.has(device)),
    ...candidates.filter((device) => !completed.has(device)),
  ];
}

function dtypeCandidates(preset: ModelPreset, device: 'webgpu' | 'wasm'): DTypeConfig[] {
  const preferred = preset.dtype[device];
  if (typeof preferred !== 'string') return [preferred];
  if (preset.task === 'text2text-generation') {
    return [...new Set<DType>([preferred, device === 'webgpu' ? 'fp16' : 'q8', 'q8'])];
  }
  // Causal LMs can be large — only try memory-frugal quantizations (never fp16/fp32).
  const fallbacks: DType[] = device === 'webgpu' ? ['q4f16', 'q4', 'q8'] : ['q4', 'q8'];
  return [...new Set<DType>([preferred, ...fallbacks])];
}

/** Whether an error looks like an out-of-memory / allocation failure. */
export function isMemoryError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('memory') ||
    text.includes('allocation') ||
    text.includes('array buffer') ||
    text.includes('oom') ||
    text.includes('aborted')
  );
}

const DTYPE_MEMORY_RANK: Record<DType, number> = {
  auto: 100,
  fp32: 32,
  fp16: 16,
  q8: 8,
  q4f16: 5,
  q4: 4,
};

function dtypeMemoryRank(dtype: DTypeConfig): number {
  if (typeof dtype === 'string') return DTYPE_MEMORY_RANK[dtype];
  return Math.max(...Object.values(dtype).map((component) => DTYPE_MEMORY_RANK[component]));
}

function hasSmallerCandidate(candidates: readonly DTypeConfig[], index: number): boolean {
  const current = candidates[index];
  return (
    current !== undefined &&
    candidates
      .slice(index + 1)
      .some((candidate) => dtypeMemoryRank(candidate) < dtypeMemoryRank(current))
  );
}

interface RawProgress {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

/** Aggregates per-file download progress into a single, monotonic 0–99% value. */
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
    this.max = Math.max(this.max, Math.min(99, Math.round((sumLoaded / denom) * 100)));
    return this.max;
  }
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

function dtypeLabel(dtype: DTypeConfig): string {
  return typeof dtype === 'string' ? dtype : JSON.stringify(dtype);
}

async function buildPipeline(
  preset: ModelPreset,
  device: 'webgpu' | 'wasm',
  dtype: DTypeConfig,
  onRaw: (raw: RawProgress) => void,
): Promise<TextGenerator> {
  const progress_callback = (raw: unknown): void => onRaw(raw as RawProgress);
  log.info(`Loading ${preset.modelId} on ${device} (${dtypeLabel(dtype)}).`);
  return createPipeline(preset.task, preset.modelId, { device, dtype, progress_callback });
}

export class TransformersBackend implements Backend {
  private generator: TextGenerator | null = null;
  private preset: ModelPreset | null = null;

  async load(config: RunnerConfig, onProgress: ProgressFn): Promise<LoadedBackend> {
    const hasWebGPU = await detectWebGPU();
    if (config.device === 'webgpu' && !hasWebGPU) {
      throw new Error('WebGPU is not available on this device.');
    }
    const preset = resolvePreset(config.model, hasWebGPU && config.device !== 'wasm');
    const devices = await orderedDeviceCandidates(config.device, hasWebGPU, preset);
    await markModelDownloadStarted(preset.modelId, config.device);
    const expectedBytes = preset.approxDownloadMB * 1024 * 1024;
    let lastError: unknown = new Error('No backend available');

    for (const device of devices) {
      const dtypes = dtypeCandidates(preset, device);
      for (const [index, dtype] of dtypes.entries()) {
        const aggregator = new ProgressAggregator(expectedBytes);
        try {
          const generator = await buildPipeline(preset, device, dtype, (raw) => {
            if (raw.status === 'progress' || raw.status === 'done') {
              onProgress(aggregator.update(raw), preset.modelId, device);
            }
          });
          this.generator = generator;
          this.preset = preset;
          await markModelDownloadComplete(preset.modelId, device).catch((error: unknown) =>
            log.warn('Could not record the completed model cache.', error),
          );
          return { label: preset.label, modelId: preset.modelId, device };
        } catch (error) {
          lastError = error;
          log.warn(`Load failed on ${device}/${dtypeLabel(dtype)}.`, error);
          if (isMemoryError(error) && !hasSmallerCandidate(dtypes, index)) break;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async generate(sentence: string): Promise<string> {
    const generator = this.generator;
    const preset = this.preset;
    if (!generator || !preset) throw new Error('Transformers backend not loaded');

    const maxNewTokens = Math.min(256, Math.max(32, Math.round(sentence.length / 2) + 24));
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
      return extractText(output);
    }
    const output = await generator(buildT5Prompt(sentence), { max_new_tokens: maxNewTokens });
    return extractText(output);
  }

  async dispose(): Promise<void> {
    const gen = this.generator;
    this.generator = null;
    this.preset = null;
    if (gen?.dispose) {
      try {
        await gen.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Downloads and caches a Transformers.js model's files (load a throwaway pipeline, then dispose). */
export async function downloadTransformersModel(
  preset: ModelPreset,
  onProgress: (progress: number) => void,
  devicePreference: RunnerConfig['device'] = 'auto',
): Promise<void> {
  const hasWebGPU = await detectWebGPU();
  if (devicePreference === 'webgpu' && !hasWebGPU) {
    throw new Error('WebGPU is not available on this device.');
  }
  if (preset.requiresWebGPU && (devicePreference === 'wasm' || !hasWebGPU)) {
    throw new Error(`${preset.label} requires WebGPU.`);
  }
  const devices = await orderedDeviceCandidates(devicePreference, hasWebGPU, preset);
  await markModelDownloadStarted(preset.modelId, devicePreference);
  const expectedBytes = preset.approxDownloadMB * 1024 * 1024;
  let lastError: unknown = new Error('No backend available');
  for (const device of devices) {
    const dtypes = dtypeCandidates(preset, device);
    for (const [index, dtype] of dtypes.entries()) {
      const aggregator = new ProgressAggregator(expectedBytes);
      try {
        const generator = await buildPipeline(preset, device, dtype, (raw) => {
          if (raw.status === 'progress' || raw.status === 'done')
            onProgress(aggregator.update(raw));
        });
        await generator.dispose?.();
        await markModelDownloadComplete(preset.modelId, device);
        return;
      } catch (error) {
        lastError = error;
        log.warn(`Download failed on ${device}/${dtypeLabel(dtype)}.`, error);
        if (isMemoryError(error) && !hasSmallerCandidate(dtypes, index)) break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// =====================================================================
// Chrome built-in AI (Prompt API / Gemini Nano)
// =====================================================================

export class PromptApiBackend implements Backend {
  private session: LanguageModelSession | null = null;
  private createOptions: LanguageModelCreateOptions | null = null;

  static isPresent(): boolean {
    return typeof globalThis.LanguageModel !== 'undefined';
  }

  async load(config: RunnerConfig, onProgress: ProgressFn): Promise<LoadedBackend> {
    const lm = globalThis.LanguageModel;
    if (!lm) throw new Error('Chrome built-in AI (Prompt API) is not available in this browser.');

    // Pin the input/output language so Chrome can attest output safety (a
    // missing output language logs a warning and can lower quality).
    const languageOptions = promptApiLanguageOptions(config.language);
    const availability = await lm.availability(languageOptions);
    if (availability === 'unavailable') {
      throw new Error('Chrome built-in AI is unavailable on this device.');
    }
    // The offscreen document has no user gesture, so a not-yet-downloaded model
    // can't be fetched here. In `auto` mode, defer to Transformers.js until the
    // user sets it up from the Options page (a real user-gesture context).
    if (availability !== 'available' && config.backend === 'auto') {
      throw new Error('Chrome built-in AI model is not downloaded yet.');
    }

    const params = await lm.params().catch(() => null);
    const tuning = params ? { topK: 1, temperature: params.defaultTemperature } : {};
    this.createOptions = { initialPrompts: buildInitialPrompts(), ...languageOptions, ...tuning };

    onProgress(availability === 'available' ? 100 : 1, 'Chrome built-in AI', 'built-in');
    this.session = await lm.create({
      ...this.createOptions,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          const loaded = (event as ProgressEvent).loaded;
          onProgress(Math.min(99, Math.round(loaded * 100)), 'Chrome built-in AI', 'built-in');
        });
      },
    });
    return {
      label: 'Chrome built-in AI',
      modelId: 'Chrome built-in AI',
      device: 'built-in',
    };
  }

  async generate(sentence: string): Promise<string> {
    const base = this.session;
    if (!base) throw new Error('Prompt API backend not loaded');

    // Always run on a throwaway session (clone, else a fresh one) so independent
    // sentences never accumulate context in the shared base session.
    let session: LanguageModelSession;
    try {
      session = await base.clone();
    } catch {
      const lm = globalThis.LanguageModel;
      if (!lm || !this.createOptions) throw new Error('Could not create a Prompt API session');
      session = await lm.create(this.createOptions);
    }

    try {
      return await session.prompt(sentence);
    } finally {
      session.destroy();
    }
  }

  dispose(): Promise<void> {
    this.session?.destroy();
    this.session = null;
    this.createOptions = null;
    return Promise.resolve();
  }
}

/** Ordered list of backend factories to try for a given preference. */
export function pickBackends(config: RunnerConfig): (() => Backend)[] {
  if (config.backend === 'transformers') return [() => new TransformersBackend()];
  if (config.backend === 'prompt') return [() => new PromptApiBackend()];
  // auto: prefer Chrome built-in AI when present, then fall back to Transformers.js.
  const backends: (() => Backend)[] = [];
  if (PromptApiBackend.isPresent()) backends.push(() => new PromptApiBackend());
  backends.push(() => new TransformersBackend());
  return backends;
}

export { getPreset, MODEL_PRESETS };
