import { describe, it, expect } from 'vitest';
import { toPromptApiLanguage, promptApiLanguageOptions } from './prompt-language';

describe('toPromptApiLanguage', () => {
  it('passes through supported languages', () => {
    expect(toPromptApiLanguage('en')).toBe('en');
    expect(toPromptApiLanguage('fr')).toBe('fr');
    expect(toPromptApiLanguage('ja')).toBe('ja');
  });

  it('reduces BCP-47 tags to the primary subtag', () => {
    expect(toPromptApiLanguage('en-US')).toBe('en');
    expect(toPromptApiLanguage('fr-CA')).toBe('fr');
    expect(toPromptApiLanguage('DE-de')).toBe('de');
  });

  it('falls back to English for unsupported or empty input', () => {
    expect(toPromptApiLanguage('zh')).toBe('en');
    expect(toPromptApiLanguage('')).toBe('en');
    expect(toPromptApiLanguage(undefined)).toBe('en');
  });
});

describe('promptApiLanguageOptions', () => {
  it('always specifies a text output language', () => {
    const opts = promptApiLanguageOptions('en');
    expect(opts.expectedInputs).toEqual([{ type: 'text', languages: ['en'] }]);
    expect(opts.expectedOutputs).toEqual([{ type: 'text', languages: ['en'] }]);
  });

  it('keeps English (system prompt) alongside a non-English target language', () => {
    const opts = promptApiLanguageOptions('fr-CA');
    expect(opts.expectedInputs).toEqual([{ type: 'text', languages: ['en', 'fr'] }]);
    expect(opts.expectedOutputs).toEqual([{ type: 'text', languages: ['fr'] }]);
  });
});
