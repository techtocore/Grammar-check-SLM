// Model catalogue. The newest Transformers.js-verified text-generation models
// are the Qwen3 family (onnx-community, library_name: transformers.js). A legacy
// FLAN-T5 option is kept for maximum compatibility / lowest-end devices.

export type ModelTask = 'text-generation' | 'text2text-generation';
export type DevicePreference = 'auto' | 'webgpu' | 'wasm';
export type DType = 'auto' | 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

export interface ModelPreset {
  /** Stable preset key stored in settings. */
  id: string;
  /** Hugging Face repo id passed to Transformers.js. */
  modelId: string;
  label: string;
  description: string;
  task: ModelTask;
  approxDownloadMB: number;
  /** Recommended quantization per backend. */
  dtype: { webgpu: DType; wasm: DType };
  /** Qwen3 models emit <think> reasoning traces; disable thinking when true. */
  reasoning?: boolean;
  /** Suggested only when WebGPU is available (large models). */
  requiresWebGPU?: boolean;
}

export const AUTO_MODEL = 'auto';

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'qwen3-0.6b',
    modelId: 'onnx-community/Qwen3-0.6B-ONNX',
    label: 'Qwen3 0.6B · Recommended',
    description: 'Newest small LLM. Fast and reliable; loads on most devices.',
    task: 'text-generation',
    approxDownloadMB: 550,
    dtype: { webgpu: 'q4f16', wasm: 'q8' },
    reasoning: true,
  },
  {
    id: 'qwen3-1.7b',
    modelId: 'onnx-community/Qwen3-1.7B-ONNX',
    label: 'Qwen3 1.7B · Higher quality',
    description: 'Stronger corrections, but needs ~2 GB of free memory and WebGPU.',
    task: 'text-generation',
    approxDownloadMB: 1400,
    dtype: { webgpu: 'q4f16', wasm: 'q4' },
    reasoning: true,
    requiresWebGPU: true,
  },
  {
    id: 'flan-t5-base',
    modelId: 'Xenova/flan-t5-base',
    label: 'FLAN-T5 Base · Compatibility',
    description: 'Lightweight legacy model. Works everywhere; lower quality.',
    task: 'text2text-generation',
    approxDownloadMB: 250,
    dtype: { webgpu: 'fp16', wasm: 'q8' },
  },
];

export function getPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id);
}

/** Best default preset. Uses the small, reliable model that loads on the widest
 * range of hardware; larger models are opt-in via Settings. */
export function defaultPresetForDevice(_hasWebGPU: boolean): ModelPreset {
  return getPreset('qwen3-0.6b') ?? MODEL_PRESETS[0]!;
}

/**
 * Resolves the configured model setting (which may be `'auto'` or a preset id)
 * into a concrete preset, using the capability hint for `'auto'`.
 */
export function resolvePreset(modelSetting: string, hasWebGPU: boolean): ModelPreset {
  if (modelSetting === AUTO_MODEL) return defaultPresetForDevice(hasWebGPU);
  return getPreset(modelSetting) ?? defaultPresetForDevice(hasWebGPU);
}
