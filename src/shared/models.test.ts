import { describe, expect, it } from 'vitest';

import { defaultPresetForDevice, getPreset, MODEL_PRESETS, resolvePreset } from './models';

describe('model catalogue', () => {
  it('offers only the current recommended model and a low-memory fallback', () => {
    expect(MODEL_PRESETS.map((preset) => preset.id)).toEqual(['qwen3.5-0.8b', 'qwen3-0.6b']);
    expect(getPreset('qwen3-1.7b')).toBeUndefined();
    expect(getPreset('flan-t5-base')).toBeUndefined();
  });

  it('uses Qwen3.5 with WebGPU and Qwen3 on WASM', () => {
    expect(defaultPresetForDevice(false).id).toBe('qwen3-0.6b');
    expect(defaultPresetForDevice(true).id).toBe('qwen3.5-0.8b');
    expect(resolvePreset('auto', false).id).toBe('qwen3-0.6b');
    expect(resolvePreset('qwen3.5-0.8b', false).id).toBe('qwen3-0.6b');
    expect(resolvePreset('removed-model', true).id).toBe('qwen3.5-0.8b');
  });

  it('uses the browser-verified mixed precision for Qwen3.5', () => {
    expect(getPreset('qwen3.5-0.8b')).toMatchObject({
      approxDownloadMB: 1000,
      requiresWebGPU: true,
      dtype: {
        webgpu: {
          embed_tokens: 'fp16',
          vision_encoder: 'fp16',
          decoder_model_merged: 'q4',
        },
      },
    });
  });
});
