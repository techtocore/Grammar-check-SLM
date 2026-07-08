// Languages the Chrome Prompt API (Gemini Nano) currently supports for input
// and output. A request must declare an output language so Chrome can attest to
// output safety; omitting it logs a console warning and can lower quality, and
// requesting an unsupported one may throw `NotSupportedError`.
export const PROMPT_API_LANGUAGES = ['en', 'ja', 'es', 'de', 'fr'] as const;

export type PromptApiLanguage = (typeof PROMPT_API_LANGUAGES)[number];

const SUPPORTED = new Set<string>(PROMPT_API_LANGUAGES);

/**
 * Maps a BCP-47 language tag (e.g. `en`, `en-US`, `fr-CA`) to a Prompt API
 * supported language, falling back to English for anything unsupported.
 */
export function toPromptApiLanguage(language: string | undefined): PromptApiLanguage {
  const primary = (language ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return primary && SUPPORTED.has(primary) ? (primary as PromptApiLanguage) : 'en';
}

/**
 * Builds the `expectedInputs` / `expectedOutputs` options that pin the Prompt
 * API's input and output language. These must be passed to `availability()` and
 * `create()`: without an output language Chrome warns and may degrade quality.
 *
 * The system prompt and few-shot examples are always English, so English is
 * kept in the accepted inputs even when correcting text in another language;
 * the output language matches the text being corrected.
 */
export function promptApiLanguageOptions(language: string | undefined): {
  expectedInputs: LanguageModelExpected[];
  expectedOutputs: LanguageModelExpected[];
} {
  const lang = toPromptApiLanguage(language);
  const inputLanguages = lang === 'en' ? ['en'] : ['en', lang];
  return {
    expectedInputs: [{ type: 'text', languages: inputLanguages }],
    expectedOutputs: [{ type: 'text', languages: [lang] }],
  };
}
