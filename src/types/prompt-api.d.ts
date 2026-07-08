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

  /** A modality + language expectation for a Prompt API session. */
  interface LanguageModelExpected {
    type: 'text' | 'image' | 'audio';
    /** BCP-47 language codes. The Prompt API accepts en, ja, es, de, fr. */
    languages?: string[];
  }

  interface LanguageModelCreateOptions {
    initialPrompts?: LanguageModelPrompt[];
    temperature?: number;
    topK?: number;
    signal?: AbortSignal;
    monitor?: (monitor: EventTarget) => void;
    expectedInputs?: LanguageModelExpected[];
    expectedOutputs?: LanguageModelExpected[];
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
