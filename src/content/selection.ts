import { isBackgroundSender, isContentMessage, type ContentMessage } from '../shared/messages';
import { createLogger } from '../shared/logger';

const log = createLogger('content');

type TextField = HTMLInputElement | HTMLTextAreaElement;
type CorrectResult = Extract<ContentMessage, { type: 'gc-correct-result' }>;

type SelectionSnapshot =
  | { kind: 'field'; field: TextField; start: number; end: number; value: string }
  | { kind: 'range'; range: Range; host: HTMLElement | null; hostText: string | null };

const pending = new Map<string, SelectionSnapshot | null>();

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

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function editableHost(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const host = element?.closest<HTMLElement>('[contenteditable]') ?? null;
  return host?.isContentEditable ? host : null;
}

function captureSelection(original: string): SelectionSnapshot | null {
  const active = deepActiveElement();
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (
      start !== null &&
      end !== null &&
      start !== end &&
      active.value.slice(start, end).trim() === original.trim()
    ) {
      return { kind: 'field', field: active, start, end, value: active.value };
    }
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (range.toString().trim() !== original.trim()) return null;
  const host = editableHost(range.commonAncestorContainer);
  return { kind: 'range', range, host, hostText: host?.textContent ?? null };
}

/**
 * Replaces the current selection with `corrected`. Returns 'replaced' when it
 * landed in an editable field, 'noneditable' for read-only text (copy instead),
 * or 'stale' if the selection no longer matches what was corrected.
 */
function replaceSelection(
  snapshot: SelectionSnapshot | null,
  corrected: string,
  original: string,
): 'replaced' | 'noneditable' | 'stale' {
  if (!snapshot) return 'stale';

  if (snapshot.kind === 'field') {
    const { field, start, end, value } = snapshot;
    if (!field.isConnected || field.value !== value) return 'stale';
    if (field.value.slice(start, end).trim() !== original.trim()) return 'stale';
    const next = field.value.slice(0, start) + corrected + field.value.slice(end);
    setNativeValue(field, next);
    try {
      field.setSelectionRange(start, start + corrected.length);
    } catch {
      /* some input types disallow selection */
    }
    field.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertReplacementText',
        data: corrected,
      }),
    );
    field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return 'replaced';
  }

  const { range, host, hostText } = snapshot;
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return 'stale';
  if (range.toString().trim() !== original.trim()) return 'stale';
  if (!host) return 'noneditable';
  if (!host.isConnected || !host.isContentEditable || host.textContent !== hostText) return 'stale';

  const selection = window.getSelection();
  const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const selectionUnchanged =
    current?.startContainer === range.startContainer &&
    current.startOffset === range.startOffset &&
    current.endContainer === range.endContainer &&
    current.endOffset === range.endOffset;
  range.deleteContents();
  const replacement = document.createTextNode(corrected);
  range.insertNode(replacement);
  if (selection && selectionUnchanged) {
    const caret = document.createRange();
    caret.setStartAfter(replacement);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }
  host.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertReplacementText',
      data: corrected,
    }),
  );
  return 'replaced';
}

function handleResult(message: CorrectResult): void {
  const { requestId, corrected, original, error } = message;
  const snapshot = pending.get(requestId) ?? null;
  pending.delete(requestId);
  if (error) {
    log.warn('Selection correction failed:', error);
    showMessageToast(`⚠ ${error}`, 3400);
    return;
  }
  if (corrected.trim() === original.trim()) {
    showMessageToast('✓ Already looks good', 2000);
    return;
  }
  const outcome = replaceSelection(snapshot, corrected, original);
  if (outcome === 'replaced') showMessageToast('✓ Grammar corrected', 2000);
  else if (outcome === 'noneditable') showCopyToast(corrected);
  else showMessageToast('Selection changed. Try again.', 2400);
}

/** Registers the listener that powers the "Correct grammar of selection" menu. */
export function initSelectionCorrection(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isBackgroundSender(sender, chrome.runtime.id)) return undefined;
    if (!isContentMessage(message)) return undefined;
    if (message.type === 'gc-correcting') {
      pending.set(message.requestId, captureSelection(message.original));
      showSpinnerToast('Correcting…');
    } else handleResult(message);
    return undefined;
  });
}
