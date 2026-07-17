// Model catalogue. Keep one current general-purpose model and one low-memory
// fallback, both published as browser-ready ONNX builds by onnx-community.

export type ModelTask = 'text-generation' | 'text2text-generation';
export type DevicePreference = 'auto' | 'webgpu' | 'wasm';
export type DType = 'auto' | 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
export type DTypeConfig = DType | Readonly<Record<string, DType>>;

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
  dtype: { webgpu: DTypeConfig; wasm: DTypeConfig };
  /** The model cannot run on the bundled WASM execution provider. */
  requiresWebGPU?: boolean;
}

export const AUTO_MODEL = 'auto';

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'qwen3.5-0.8b',
    modelId: 'onnx-community/Qwen3.5-0.8B-ONNX',
    label: 'Qwen3.5 0.8B · Recommended',
    description: 'Latest balanced model for modern devices with WebGPU.',
    task: 'text-generation',
    approxDownloadMB: 1000,
    dtype: {
      webgpu: {
        embed_tokens: 'fp16',
        vision_encoder: 'fp16',
        decoder_model_merged: 'q4',
      },
      wasm: 'q4',
    },
    requiresWebGPU: true,
  },
  {
    id: 'qwen3-0.6b',
    modelId: 'onnx-community/Qwen3-0.6B-ONNX',
    label: 'Qwen3 0.6B · Low memory',
    description: 'Smaller fallback for older or memory-constrained devices.',
    task: 'text-generation',
    approxDownloadMB: 550,
    dtype: { webgpu: 'q4f16', wasm: 'q8' },
  },
];

export function getPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id);
}

/** Uses the newest practical model on WebGPU and the smaller model on WASM. */
export function defaultPresetForDevice(hasWebGPU: boolean): ModelPreset {
  const id = hasWebGPU ? 'qwen3.5-0.8b' : 'qwen3-0.6b';
  return getPreset(id) ?? MODEL_PRESETS[0]!;
}

/**
 * Resolves the configured model setting (which may be `'auto'` or a preset id)
 * into a concrete preset, using the capability hint for `'auto'`.
 */
export function resolvePreset(modelSetting: string, hasWebGPU: boolean): ModelPreset {
  if (modelSetting === AUTO_MODEL) return defaultPresetForDevice(hasWebGPU);
  const preset = getPreset(modelSetting);
  if (!preset || (preset.requiresWebGPU && !hasWebGPU)) {
    return defaultPresetForDevice(hasWebGPU);
  }
  return preset;
}
