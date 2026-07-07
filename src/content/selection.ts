import { isContentMessage, type ContentMessage } from '../shared/messages';
import { createLogger } from '../shared/logger';

const log = createLogger('content');

type TextField = HTMLInputElement | HTMLTextAreaElement;
type CorrectResult = Extract<ContentMessage, { type: 'gc-correct-result' }>;

let toast: HTMLDivElement | null = null;
let hideTimer: number | null = null;

function ensureToast(): HTMLDivElement {
  if (toast) return toast;
  const node = document.createElement('div');
  node.className = 'gcslm-toast';
  node.setAttribute('role', 'status');
  document.body.appendChild(node);
  toast = node;
  return node;
}

function clearHideTimer(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function hideToast(delay = 0): void {
  clearHideTimer();
  const node = toast;
  if (!node) return;
  if (delay > 0) {
    hideTimer = window.setTimeout(() => hideToast(0), delay);
    return;
  }
  node.classList.remove('visible');
  window.setTimeout(() => {
    node.remove();
    if (toast === node) toast = null;
  }, 200);
}

function baseToast(): HTMLDivElement {
  clearHideTimer();
  const node = ensureToast();
  node.replaceChildren();
  requestAnimationFrame(() => node.classList.add('visible'));
  return node;
}

function showSpinnerToast(text: string): void {
  const node = baseToast();
  const spinner = document.createElement('span');
  spinner.className = 'gcslm-toast-spinner';
  const label = document.createElement('span');
  label.className = 'gcslm-toast-text';
  label.textContent = text;
  node.append(spinner, label);
}

function showMessageToast(text: string, autoHideMs = 2200): void {
  const node = baseToast();
  const label = document.createElement('span');
  label.className = 'gcslm-toast-text';
  label.textContent = text;
  node.append(label);
  hideToast(autoHideMs);
}

function showCopyToast(corrected: string): void {
  const node = baseToast();
  const label = document.createElement('span');
  label.className = 'gcslm-toast-text';
  label.textContent = 'Corrected text ready';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'gcslm-toast-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(corrected).then(
      () => {
        copyBtn.textContent = 'Copied!';
        hideToast(1200);
      },
      () => {
        copyBtn.textContent = 'Copy failed';
      },
    );
  });
  node.append(label, copyBtn);
  hideToast(8000);
}

function setNativeValue(field: TextField, value: string): void {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  /* eslint-disable @typescript-eslint/unbound-method -- setters are invoked immediately via .call */
  const prototypeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const instanceSetter = Object.getOwnPropertyDescriptor(field, 'value')?.set;
  /* eslint-enable @typescript-eslint/unbound-method */
  if (prototypeSetter && prototypeSetter !== instanceSetter) {
    prototypeSetter.call(field, value);
  } else {
    field.value = value;
  }
}

/**
 * Replaces the current selection with `corrected`. Returns 'replaced' when it
 * landed in an editable field, 'noneditable' for read-only text (copy instead),
 * or 'stale' if the selection no longer matches what was corrected.
 */
function replaceSelection(
  corrected: string,
  original: string,
): 'replaced' | 'noneditable' | 'stale' {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start !== null && end !== null && start !== end) {
      if (active.value.slice(start, end).trim() !== original.trim()) return 'stale';
      const next = active.value.slice(0, start) + corrected + active.value.slice(end);
      setNativeValue(active, next);
      try {
        active.setSelectionRange(start, start + corrected.length);
      } catch {
        /* some input types disallow selection */
      }
      active.dispatchEvent(new Event('input', { bubbles: true }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
      return 'replaced';
    }
  }

  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    if (selection.toString().trim() !== original.trim()) return 'stale';
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    const host = element?.closest<HTMLElement>('[contenteditable=""],[contenteditable="true"]');
    if (host?.isContentEditable) {
      range.deleteContents();
      range.insertNode(document.createTextNode(corrected));
      selection.collapseToEnd();
      host.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return 'replaced';
    }
    return 'noneditable';
  }

  return 'stale';
}

function handleResult(message: CorrectResult): void {
  const { corrected, original, error } = message;
  if (error) {
    log.warn('Selection correction failed:', error);
    showMessageToast(`⚠ ${error}`, 3400);
    return;
  }
  if (corrected.trim() === original.trim()) {
    showMessageToast('✓ Already looks good', 2000);
    return;
  }
  const outcome = replaceSelection(corrected, original);
  if (outcome === 'replaced') showMessageToast('✓ Grammar corrected', 2000);
  else showCopyToast(corrected);
}

/** Registers the listener that powers the "Correct grammar of selection" menu. */
export function initSelectionCorrection(): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isContentMessage(message)) return undefined;
    if (message.type === 'gc-correcting') showSpinnerToast('Correcting…');
    else handleResult(message);
    return undefined;
  });
}
