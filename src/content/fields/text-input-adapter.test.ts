import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextInputAdapter } from './text-input-adapter';

describe('TextInputAdapter.applyEdit', () => {
  beforeEach(() => document.body.replaceChildren());

  it('preserves and adjusts a selection after an earlier replacement', () => {
    const field = document.createElement('textarea');
    field.value = 'I has a cat at home.';
    document.body.append(field);
    field.setSelectionRange(15, 19, 'forward');
    const adapter = new TextInputAdapter(field);
    const events: string[] = [];
    field.addEventListener('beforeinput', () => events.push('beforeinput'));
    field.addEventListener('input', (event) => {
      events.push(event.inputType);
    });

    expect(adapter.applyEdit(2, 5, 'has', 'have')).toBe(true);
    expect(field.value).toBe('I have a cat at home.');
    expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([
      16,
      20,
      'forward',
    ]);
    expect(events).toEqual(['beforeinput', 'insertReplacementText']);
    adapter.destroy();
  });

  it('honors a cancelled beforeinput event', () => {
    const field = document.createElement('input');
    field.value = 'I has a cat.';
    document.body.append(field);
    field.addEventListener('beforeinput', (event) => event.preventDefault());
    const onInput = vi.fn();
    field.addEventListener('input', onInput);
    const adapter = new TextInputAdapter(field);

    expect(adapter.applyEdit(2, 5, 'has', 'have')).toBe(false);
    expect(field.value).toBe('I has a cat.');
    expect(onInput).not.toHaveBeenCalled();
    adapter.destroy();
  });
});
