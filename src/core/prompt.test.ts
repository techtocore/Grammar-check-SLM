import { describe, it, expect } from 'vitest';
import {
  buildMessages,
  buildInitialPrompts,
  cleanModelOutput,
  GRAMMAR_SYSTEM_PROMPT,
} from './prompt';

describe('buildMessages', () => {
  it('starts with the system prompt and ends with the sentence', () => {
    const messages = buildMessages('I has a cat');
    expect(messages[0]).toEqual({ role: 'system', content: GRAMMAR_SYSTEM_PROMPT });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'I has a cat' });
    expect(messages.length).toBeGreaterThan(2); // includes few-shot examples
  });
});

describe('buildInitialPrompts', () => {
  it('is the system + few-shot context without a trailing sentence', () => {
    const initial = buildInitialPrompts();
    expect(initial[0]).toEqual({ role: 'system', content: GRAMMAR_SYSTEM_PROMPT });
    // Every message must have content (no empty trailing user turn).
    for (const m of initial) expect(m.content.length).toBeGreaterThan(0);
    expect(initial[initial.length - 1]!.role).toBe('assistant');
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
    expect(cleanModelOutput('Here is your corrected sentence: He goes home.', 'x')).toBe(
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

  it('preserves quotes that are part of the source sentence', () => {
    expect(cleanModelOutput('"He goes home."', '"He go home."')).toBe('"He goes home."');
  });

  it('preserves legitimate label-like text from the source', () => {
    const source = 'Here is my answer: the project is ready for review tomorrow.';
    expect(cleanModelOutput(source, source)).toBe(source);
    expect(cleanModelOutput('Answer: Yes, it is.', 'Answer: No, it is not.')).toBe(
      'Answer: Yes, it is.',
    );
  });

  it('preserves literal think tags from the source', () => {
    expect(cleanModelOutput('<think>He goes home.</think>', '<think>He go home.</think>')).toBe(
      '<think>He goes home.</think>',
    );
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

  it('keeps only the corrected sentence, dropping trailing explanation lines', () => {
    expect(cleanModelOutput('He goes home.\n\nExplanation: fixed the verb.', 'x')).toBe(
      'He goes home.',
    );
  });

  it('drops common unlabelled commentary on a following line', () => {
    const source = 'This is a fairly long sentence that contain one simple grammar mistake today.';
    const raw =
      'This is a fairly long sentence that contains one simple grammar mistake today.\nI fixed the verb.';
    expect(cleanModelOutput(raw, source)).toBe(
      'This is a fairly long sentence that contains one simple grammar mistake today.',
    );
  });

  it('joins an answer wrapped across multiple lines', () => {
    const source = 'One two three four five six seven eight nine ten.';
    expect(cleanModelOutput('One two three four five six\r\nseven eight nine ten.', source)).toBe(
      source,
    );
  });

  it('handles a label line followed by the answer on the next line', () => {
    expect(cleanModelOutput('Corrected sentence:\nHe goes home.', 'x')).toBe('He goes home.');
  });
});
