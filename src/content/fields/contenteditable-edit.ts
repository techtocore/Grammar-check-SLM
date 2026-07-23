function restoreSelection(
  selection: Selection,
  activeElement: Element | null,
  anchorNode: Node | null,
  anchorOffset: number,
  focusNode: Node | null,
  focusOffset: number,
): void {
  if (activeElement instanceof HTMLElement && activeElement.isConnected) {
    activeElement.focus({ preventScroll: true });
  }
  if (anchorNode?.isConnected && focusNode?.isConnected) {
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  } else {
    selection.removeAllRanges();
  }
}

/**
 * Replaces a range through the browser's editing pipeline. Framework-backed
 * editors such as Lexical must receive a real editing command so their model,
 * DOM, selection, and undo history remain synchronized.
 */
export function replaceContentEditableRange(
  host: HTMLElement,
  range: Range,
  replacement: string,
): boolean {
  if (
    !host.isConnected ||
    !host.contains(range.startContainer) ||
    !host.contains(range.endContainer) ||
    (range.collapsed && replacement === '')
  ) {
    return false;
  }

  const ownerDocument = host.ownerDocument;
  const selection = ownerDocument.defaultView?.getSelection();
  if (!selection) return false;

  const activeElement = ownerDocument.activeElement;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  const restore = (): void =>
    restoreSelection(selection, activeElement, anchorNode, anchorOffset, focusNode, focusOffset);

  host.focus({ preventScroll: true });
  if (
    !host.contains(range.startContainer) ||
    !host.contains(range.endContainer) ||
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected
  ) {
    restore();
    return false;
  }
  selection.removeAllRanges();
  selection.addRange(range);

  if (typeof ownerDocument.execCommand === 'function') {
    const applied =
      replacement === ''
        ? ownerDocument.execCommand('delete', false)
        : ownerDocument.execCommand('insertText', false, replacement);
    if (!applied) restore();
    return applied;
  }

  const inputType = range.collapsed
    ? 'insertText'
    : replacement === ''
      ? 'deleteContentBackward'
      : 'insertReplacementText';
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    composed: true,
    cancelable: true,
    inputType,
    data: replacement || null,
  });
  if (!host.dispatchEvent(beforeInput)) {
    restore();
    return false;
  }

  range.deleteContents();
  if (replacement) {
    const node = ownerDocument.createTextNode(replacement);
    range.insertNode(node);
    range.setStartAfter(node);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  host.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType,
      // The DOM already contains the replacement. Supplying data here can make
      // controlled editors interpret this notification as another insertion.
      data: null,
    }),
  );
  return true;
}
