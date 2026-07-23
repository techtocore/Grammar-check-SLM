import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installExecCommand } from '../exec-command.test-helper';
import { ContentEditableAdapter } from './contenteditable-adapter';

function select(root: HTMLElement, anchor: number, focus = anchor): void {
  const text = root.firstChild;
  if (!(text instanceof Text)) throw new Error('Expected one text node');
  const selection = window.getSelection();
  selection?.setBaseAndExtent(text, anchor, text, focus);
}

function selectionOffsets(root: HTMLElement): [number, number] {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) throw new Error('Expected a selection');
  const offset = (node: Node, nodeOffset: number): number => {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
  };
  return [
    offset(selection.anchorNode, selection.anchorOffset),
    offset(selection.focusNode, selection.focusOffset),
  ];
}

describe('ContentEditableAdapter.applyEdit', () => {
  beforeEach(() => document.body.replaceChildren());

  it('keeps an end caret at the logical end after an earlier replacement', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    root.textContent = 'They was going too school yesterday.';
    document.body.append(root);
    select(root, root.textContent.length);
    const adapter = new ContentEditableAdapter(root);

    expect(adapter.applyEdit(5, 8, 'was', 'were')).toBe(true);
    expect(root.textContent).toBe('They were going too school yesterday.');
    expect(selectionOffsets(root)).toEqual([37, 37]);
    adapter.destroy();
  });

  it('preserves a backward selection after an earlier replacement', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    root.textContent = 'They was going too school yesterday.';
    document.body.append(root);
    select(root, 36, 26);
    const adapter = new ContentEditableAdapter(root);

    expect(adapter.applyEdit(5, 8, 'was', 'were')).toBe(true);
    expect(selectionOffsets(root)).toEqual([37, 27]);
    adapter.destroy();
  });

  it('moves a caret inside the replaced text to the end of the suggestion', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    root.textContent = 'They was going home.';
    document.body.append(root);
    select(root, 6);
    const adapter = new ContentEditableAdapter(root);

    expect(adapter.applyEdit(5, 8, 'was', 'were')).toBe(true);
    expect(selectionOffsets(root)).toEqual([9, 9]);
    adapter.destroy();
  });

  it('uses the browser editing pipeline for a WhatsApp Lexical editor', () => {
    const root = document.createElement('div');
    root.setAttribute('contenteditable', 'true');
    root.setAttribute('data-lexical-editor', 'true');
    root.innerHTML = '<p><span data-lexical-text="true">Getting a new experrience</span></p>';
    document.body.append(root);
    const text = root.querySelector('[data-lexical-text]')?.firstChild;
    if (!(text instanceof Text)) throw new Error('Expected Lexical text node');
    const original = 'experrience';
    const start = text.data.indexOf(original);
    window.getSelection()?.setBaseAndExtent(text, start, text, start + original.length);
    const onInput = vi.fn();
    root.addEventListener('input', onInput);
    const { command, restore } = installExecCommand(root);
    const adapter = new ContentEditableAdapter(root);

    try {
      expect(adapter.applyEdit(start, start + original.length, original, 'experience')).toBe(true);
      expect(root.textContent).toBe('Getting a new experience');
      expect(command).toHaveBeenCalledExactlyOnceWith('insertText', false, 'experience');
      expect(onInput).toHaveBeenCalledOnce();
    } finally {
      adapter.destroy();
      restore();
    }
  });

  it('uses the browser delete command for removal suggestions', () => {
    const root = document.createElement('div');
    root.setAttribute('contenteditable', 'true');
    root.textContent = 'This is very good.';
    document.body.append(root);
    select(root, root.textContent.length);
    const start = root.textContent.indexOf('very ');
    const { command, restore } = installExecCommand(root);
    const adapter = new ContentEditableAdapter(root);

    try {
      expect(adapter.applyEdit(start, start + 5, 'very ', '')).toBe(true);
      expect(root.textContent).toBe('This is good.');
      expect(command).toHaveBeenCalledExactlyOnceWith('delete', false);
    } finally {
      adapter.destroy();
      restore();
    }
  });
});
