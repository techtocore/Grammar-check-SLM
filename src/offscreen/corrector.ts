import { pipeline, env } from '@huggingface/transformers';

import { segmentSentences } from '../core/segment';
import { assembleCorrections } from '../core/corrections';
import { buildMessages, buildT5Prompt, cleanModelOutput } from '../core/prompt';
import { LRUCache } from '../core/cache';
import type { Correction } from '../core/types';
import type { ModelStatus, RunnerConfig } from '../shared/messages';
import { resolvePreset, type ModelPreset } from '../shared/models';
import { createLogger } from '../shared/logger';

const log = createLogger('runner');

// ---- Configure Transformers.js for the extension environment (once) ----
env.allowLocalModels = false;
const onnxWasm = env.backends?.onnx?.wasm as
  { wasmPaths?: string; numThreads?: number } | undefined;
if (onnxWasm) {
  // Serve the ONNX Runtime binary from the bundled copy (CSP-safe, offline-capable).
  onnxWasm.wasmPaths = chrome.runtime.getURL('ort/');
  // Extension pages are not cross-origin isolated -> no SharedArrayBuffer/threads.
  onnxWasm.numThreads = 1;
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

function resolveDevice(pref: RunnerConfig['device'], hasWebGPU: boolean): 'webgpu' | 'wasm' {
  if (pref === 'wasm') return 'wasm';
  if (pref === 'webgpu') return hasWebGPU ? 'webgpu' : 'wasm';
  return hasWebGPU ? 'webgpu' : 'wasm';
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
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  async correct(text: string): Promise<Correction[]> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const config = this.config;
      const preset = this.preset;
      if (!config || !preset) return [];
      const sentences = segmentSentences(text, config.language)
        .filter((s) => s.text.length <= 400)
        .slice(0, 40);
      const corrected: string[] = [];
      for (const sentence of sentences) {
        corrected.push(await this.correctSentence(sentence.text, preset));
      }
      return assembleCorrections(text, sentences, corrected);
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
    let device = resolveDevice(config.device, hasWebGPU);
    const preset = resolvePreset(config.model, hasWebGPU);
    this.setStatus({ state: 'loading', progress: 0, modelId: preset.modelId, device });

    let generator: TextGenerator;
    try {
      generator = await this.build(preset, device, preset.dtype[device]);
    } catch (error) {
      if (device === 'webgpu') {
        log.warn('WebGPU model load failed; retrying on WASM.', error);
        device = 'wasm';
        this.setStatus({ state: 'loading', progress: 0, device });
        try {
          generator = await this.build(preset, 'wasm', preset.dtype.wasm);
        } catch (wasmError) {
          if (generation === this.loadGeneration) this.failLoad(wasmError);
          throw wasmError;
        }
      } else {
        if (generation === this.loadGeneration) this.failLoad(error);
        throw error;
      }
    }

    // A newer configuration superseded this load while it was running.
    if (generation !== this.loadGeneration) {
      try {
        await generator.dispose?.();
      } catch {
        /* ignore */
      }
      return;
    }

    this.generator = generator;
    this.preset = preset;
    this.setStatus({ state: 'ready', progress: 100, device });
  }

  private failLoad(error: unknown): void {
    this.loadPromise = null;
    this.setStatus({
      state: 'error',
      progress: 0,
      error: error instanceof Error ? error.message : String(error),
      message: 'Failed to load the model',
    });
  }

  private async build(
    preset: ModelPreset,
    device: 'webgpu' | 'wasm',
    dtype: string,
  ): Promise<TextGenerator> {
    const progress_callback = (raw: unknown): void => {
      const data = raw as { status?: string; progress?: number };
      if (data.status === 'progress' && typeof data.progress === 'number') {
        this.setStatus({ state: 'loading', progress: Math.min(99, Math.round(data.progress)) });
      }
    };
    log.info(`Loading ${preset.modelId} on ${device} (${dtype}).`);
    return createPipeline(preset.task, preset.modelId, { device, dtype, progress_callback });
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
