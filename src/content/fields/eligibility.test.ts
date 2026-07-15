import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { fieldKindFor } from './eligibility';

describe('fieldKindFor', () => {
  it('rejects a field as soon as it becomes sensitive or read-only', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(fieldKindFor(input, DEFAULT_SETTINGS)).toBe('textinput');

    input.type = 'password';
    expect(fieldKindFor(input, DEFAULT_SETTINGS)).toBeNull();

    input.type = 'text';
    input.readOnly = true;
    expect(fieldKindFor(input, DEFAULT_SETTINGS)).toBeNull();
  });

  it('honors field-type settings', () => {
    const textarea = document.createElement('textarea');
    expect(fieldKindFor(textarea, { ...DEFAULT_SETTINGS, checkTextInputs: false })).toBeNull();
  });
});
