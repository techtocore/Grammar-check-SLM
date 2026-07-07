// Minimal ambient types for the Chrome built-in AI "Prompt API" (LanguageModel).
// See https://developer.chrome.com/docs/ai/prompt-api. Not all Chrome builds
// expose it, so access via `globalThis.LanguageModel` and feature-detect.

export {};

declare global {
  type LanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

  interface LanguageModelPrompt {
    role: 'system' | 'user' | 'assistant';
    content: string;
    prefix?: boolean;
  }

  interface LanguageModelParams {
    defaultTopK: number;
    maxTopK: number;
    defaultTemperature: number;
    maxTemperature: number;
  }

  interface LanguageModelCreateOptions {
    initialPrompts?: LanguageModelPrompt[];
    temperature?: number;
    topK?: number;
    signal?: AbortSignal;
    monitor?: (monitor: EventTarget) => void;
  }

  interface LanguageModelSession {
    prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>;
    clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
    destroy(): void;
  }

  interface LanguageModelStatic {
    availability(options?: LanguageModelCreateOptions): Promise<LanguageModelAvailability>;
    create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
    params(): Promise<LanguageModelParams | null>;
  }

  var LanguageModel: LanguageModelStatic | undefined;
}
