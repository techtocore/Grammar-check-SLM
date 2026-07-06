// Maps between the plain-text view of a contenteditable element and its DOM,
// so word-level correction offsets can be turned into DOM Ranges and applied
// without destroying the element's markup or the caret position.

export interface CharPos {
  node: Text;
  offset: number;
}

export interface DomText {
  text: string;
  /** For each char index in `text`: its DOM position, or null for a synthetic separator. */
  positions: Array<CharPos | null>;
}

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TR',
  'UL',
]);

function nearestBlock(node: Node, root: HTMLElement): Element {
  let current: Node | null = node.parentNode;
  while (current && current !== root) {
    if (current instanceof HTMLElement && BLOCK_TAGS.has(current.tagName)) return current;
    current = current.parentNode;
  }
  return root;
}

/** Builds the plain-text projection of a contenteditable element with a char→DOM map. */
export function buildDomText(root: HTMLElement): DomText {
  const positions: Array<CharPos | null> = [];
  let text = '';
  let lastBlock: Element | null = null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node): number {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node.nodeName === 'BR') return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    if (node.nodeName === 'BR') {
      text += '\n';
      positions.push(null);
      lastBlock = null;
      continue;
    }
    const textNode = node as Text;
    const block = nearestBlock(textNode, root);
    if (lastBlock !== null && block !== lastBlock) {
      text += '\n';
      positions.push(null);
    }
    lastBlock = block;
    const data = textNode.data;
    for (let k = 0; k < data.length; k++) {
      text += data[k];
      positions.push({ node: textNode, offset: k });
    }
  }

  return { text, positions };
}

function caretAfterLast(dom: DomText, index: number): CharPos | null {
  for (let k = Math.min(index, dom.positions.length - 1); k >= 0; k--) {
    const pos = dom.positions[k];
    if (pos) return { node: pos.node, offset: pos.offset + 1 };
  }
  return null;
}

function caretBefore(dom: DomText, index: number): CharPos | null {
  const pos = dom.positions[index];
  if (pos) return { node: pos.node, offset: pos.offset };
  return caretAfterLast(dom, index - 1);
}

function caretAfter(dom: DomText, index: number): CharPos | null {
  const pos = dom.positions[index];
  if (pos) return { node: pos.node, offset: pos.offset + 1 };
  return caretAfterLast(dom, index - 1);
}

/** Resolves a [start, end) character range into a DOM Range (collapsed if start === end). */
export function resolveRange(dom: DomText, start: number, end: number): Range | null {
  const startCaret = caretBefore(dom, start);
  const endCaret = start === end ? startCaret : caretAfter(dom, end - 1);
  if (!startCaret || !endCaret) return null;
  try {
    const range = document.createRange();
    range.setStart(startCaret.node, startCaret.offset);
    range.setEnd(endCaret.node, endCaret.offset);
    return range;
  } catch {
    return null;
  }
}

/**
 * Applies an edit replacing [start, end) with `suggestion`, preserving markup
 * and caret where possible. Validates the current text against `expectedOriginal`
 * to avoid acting on stale offsets. Returns true on success.
 */
export function applyDomEdit(
  dom: DomText,
  start: number,
  end: number,
  expectedOriginal: string,
  suggestion: string,
): boolean {
  if (start < 0 || end > dom.text.length || start > end) return false;
  if (dom.text.slice(start, end) !== expectedOriginal) return false;

  // Insertion (zero-width).
  if (start === end) {
    const at = caretBefore(dom, start) ?? caretAfterLast(dom, start - 1);
    if (!at) return false;
    at.node.data = at.node.data.slice(0, at.offset) + suggestion + at.node.data.slice(at.offset);
    return true;
  }

  // Fast path: whole range within a single text node.
  const startPos = dom.positions[start];
  const endPos = dom.positions[end - 1];
  if (startPos && endPos && startPos.node === endPos.node) {
    const node = startPos.node;
    node.data =
      node.data.slice(0, startPos.offset) + suggestion + node.data.slice(endPos.offset + 1);
    return true;
  }

  // Cross-node fallback.
  const range = resolveRange(dom, start, end);
  if (!range) return false;
  range.deleteContents();
  if (suggestion) range.insertNode(document.createTextNode(suggestion));
  return true;
}
