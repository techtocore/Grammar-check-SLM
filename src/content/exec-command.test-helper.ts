import { vi } from 'vitest';

/** Installs a jsdom stand-in for the browser's contenteditable editing command. */
export function installExecCommand(host: HTMLElement) {
  const original = Object.getOwnPropertyDescriptor(document, 'execCommand');
  const command = vi.fn((commandId: string, _showUi?: boolean, valueArgument?: string): boolean => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();

    if (commandId.toLowerCase() === 'inserttext' && valueArgument) {
      const replacement = document.createTextNode(valueArgument);
      range.insertNode(replacement);
      range.setStartAfter(replacement);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    host.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType:
          commandId.toLowerCase() === 'inserttext' ? 'insertText' : 'deleteContentBackward',
        data: valueArgument ?? null,
      }),
    );
    return true;
  });
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: command,
  });

  return {
    command,
    restore: (): void => {
      if (original) Object.defineProperty(document, 'execCommand', original);
      else Reflect.deleteProperty(document, 'execCommand');
    },
  };
}
