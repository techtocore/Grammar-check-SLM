import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentMessage } from '../shared/messages';
import { installExecCommand } from './exec-command.test-helper';
import { initSelectionCorrection } from './selection';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
type Listener = (message: unknown, sender: chrome.runtime.MessageSender) => boolean | undefined;

let listener: Listener;

function send(message: ContentMessage): void {
  listener(message, {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/background.js`,
  });
}

describe('selection correction', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('chrome', {
      runtime: {
        id: EXTENSION_ID,
        onMessage: {
          addListener: vi.fn((registered: Listener) => {
            listener = registered;
          }),
        },
      },
    });
    initSelectionCorrection();
  });

  it('applies a result to the original field after focus moves', () => {
    const first = document.createElement('textarea');
    first.value = 'I has a cat.';
    const second = document.createElement('textarea');
    second.value = 'I has a cat.';
    document.body.append(first, second);
    const onInput = vi.fn();
    const onChange = vi.fn();
    first.addEventListener('input', onInput);
    first.addEventListener('change', onChange);

    first.focus();
    first.setSelectionRange(0, first.value.length);
    send({
      type: 'gc-correcting',
      target: 'content',
      requestId: 'one',
      original: first.value,
    });

    second.focus();
    second.setSelectionRange(0, second.value.length);
    send({
      type: 'gc-correct-result',
      target: 'content',
      requestId: 'one',
      original: 'I has a cat.',
      corrected: 'I have a cat.',
    });

    expect(first.value).toBe('I have a cat.');
    expect(second.value).toBe('I has a cat.');
    expect(document.activeElement).toBe(second);
    expect(onInput).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('does not overwrite a field edited while correction is running', () => {
    const field = document.createElement('textarea');
    field.value = 'I has a cat.';
    document.body.append(field);
    field.focus();
    field.setSelectionRange(0, field.value.length);

    send({
      type: 'gc-correcting',
      target: 'content',
      requestId: 'two',
      original: field.value,
    });
    field.value = 'I already fixed this.';
    send({
      type: 'gc-correct-result',
      target: 'content',
      requestId: 'two',
      original: 'I has a cat.',
      corrected: 'I have a cat.',
    });

    expect(field.value).toBe('I already fixed this.');
  });

  it('replaces a selected word once in a WhatsApp Lexical editor', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.tabIndex = 10;
    editor.setAttribute('data-lexical-editor', 'true');
    editor.innerHTML = '<p><span data-lexical-text="true">Getting a new experrience</span></p>';
    Object.defineProperty(editor, 'isContentEditable', {
      configurable: true,
      value: true,
    });
    document.body.append(editor);

    const text = editor.querySelector('[data-lexical-text]')?.firstChild;
    if (!(text instanceof Text)) throw new Error('Expected Lexical text node');
    const original = 'experrience';
    const start = text.data.indexOf(original);
    editor.focus();
    window.getSelection()?.setBaseAndExtent(text, start, text, start + original.length);
    const onInput = vi.fn();
    editor.addEventListener('input', onInput);
    const { command, restore } = installExecCommand(editor);

    try {
      send({
        type: 'gc-correcting',
        target: 'content',
        requestId: 'lexical',
        original,
      });
      send({
        type: 'gc-correct-result',
        target: 'content',
        requestId: 'lexical',
        original,
        corrected: 'experience',
      });

      expect(editor.textContent).toBe('Getting a new experience');
      expect(command).toHaveBeenCalledExactlyOnceWith('insertText', false, 'experience');
      expect(onInput).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });
});
