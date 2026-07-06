import { describe, it, expect } from 'vitest';
import { buildMessages, cleanModelOutput, GRAMMAR_SYSTEM_PROMPT } from './prompt';

describe('buildMessages', () => {
  it('builds a system + user chat pair', () => {
    const messages = buildMessages('I has a cat');
    expect(messages).toEqual([
      { role: 'system', content: GRAMMAR_SYSTEM_PROMPT },
      { role: 'user', content: 'I has a cat' },
    ]);
  });
});

describe('cleanModelOutput', () => {
  it('returns already-clean output untouched', () => {
    expect(cleanModelOutput('He goes home.', 'He go home.')).toBe('He goes home.');
  });

  it('strips Qwen3 <think> reasoning blocks', () => {
    expect(cleanModelOutput('<think>The verb is wrong.</think>He goes home.', 'x')).toBe(
      'He goes home.',
    );
  });

  it('strips content before a stray closing think tag', () => {
    expect(cleanModelOutput('reasoning without open tag</think> The answer.', 'x')).toBe(
      'The answer.',
    );
  });

  it('strips echoed instruction prefixes', () => {
    expect(cleanModelOutput('Corrected sentence: He goes home.', 'x')).toBe('He goes home.');
    expect(cleanModelOutput('Here is the corrected sentence: He goes home.', 'x')).toBe(
      'He goes home.',
    );
    expect(cleanModelOutput('Output: He goes home.', 'x')).toBe('He goes home.');
  });

  it('strips wrapping quotes (straight and smart)', () => {
    expect(cleanModelOutput('"He goes home."', 'x')).toBe('He goes home.');
    expect(cleanModelOutput('\u201cHe goes home.\u201d', 'x')).toBe('He goes home.');
  });

  it('does not strip internal quotes', () => {
    expect(cleanModelOutput('He said "hi" to me.', 'x')).toBe('He said "hi" to me.');
  });

  it('falls back to the source when output is empty', () => {
    expect(cleanModelOutput('<think>only reasoning</think>', 'Original text.')).toBe(
      'Original text.',
    );
    expect(cleanModelOutput('   ', 'Original text.')).toBe('Original text.');
  });

  it('collapses excess whitespace', () => {
    expect(cleanModelOutput('He   goes    home.', 'x')).toBe('He goes home.');
  });
});
