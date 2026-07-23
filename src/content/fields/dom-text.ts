// Maps between the plain-text view of a contenteditable element and its DOM,
// so word-level correction offsets can be turned into DOM Ranges and applied
// without destroying the element's markup or the caret position.

import { replaceContentEditableRange } from './contenteditable-edit';

export interface CharPos {
  node: Text;
  offset: number;
  readonly?: boolean;
}

export interface DomText {
  root: HTMLElement;
  text: string;
  /** For each char index in `text`: its DOM position, or null for a synthetic separator. */
  positions: Array<CharPos | null>;
  /** Projected offsets occupied by skipped DOM-only content. */
  barriers: number[];
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

const NON_RENDERED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

function isProtected(node: Node, root: HTMLElement): boolean {
  let element = node.parentElement;
  while (element && element !== root) {
    if (NON_RENDERED_TAGS.has(element.tagName) || element.hidden) return true;
    const editable = element.getAttribute('contenteditable')?.toLowerCase();
    if (editable === 'false') return true;
    element = element.parentElement;
  }
  return false;
}

function shouldRejectSubtree(element: Element, root: HTMLElement): boolean {
  if (element === root) return false;
  if (
    NON_RENDERED_TAGS.has(element.tagName) ||
    (element instanceof HTMLElement && element.hidden)
  ) {
    return true;
  }
  return false;
}

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
  const barriers: number[] = [];
  const recordedBarriers = new Set<Element>();
  let text = '';
  let lastBlock: Element | null = null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node): number {
      if (node instanceof Element) {
        const readonly = node.getAttribute('contenteditable')?.toLowerCase() === 'false';
        if ((readonly || shouldRejectSubtree(node, root)) && !recordedBarriers.has(node)) {
          barriers.push(text.length);
          recordedBarriers.add(node);
        }
        if (shouldRejectSubtree(node, root)) return NodeFilter.FILTER_REJECT;
      }
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
    const readonly = isProtected(textNode, root);
    for (let k = 0; k < data.length; k++) {
      text += data[k];
      positions.push({ node: textNode, offset: k, ...(readonly ? { readonly: true } : {}) });
    }
  }

  return { root, text, positions, barriers };
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
  if (pos && !pos.readonly) return { node: pos.node, offset: pos.offset };
  return caretAfterLast(dom, index - 1);
}

function caretAfter(dom: DomText, index: number): CharPos | null {
  const pos = dom.positions[index];
  if (pos) return { node: pos.node, offset: pos.offset + 1 };
  return caretAfterLast(dom, index - 1);
}

function comparePoints(left: CharPos, rightNode: Node, rightOffset: number): number | null {
  try {
    const leftRange = document.createRange();
    leftRange.setStart(left.node, left.offset);
    leftRange.collapse(true);
    const rightRange = document.createRange();
    rightRange.setStart(rightNode, rightOffset);
    rightRange.collapse(true);
    return leftRange.compareBoundaryPoints(Range.START_TO_START, rightRange);
  } catch {
    return null;
  }
}

/** Maps a live DOM selection point back to an offset in the plain-text projection. */
export function domOffsetForPoint(dom: DomText, node: Node, offset: number): number | null {
  if (node instanceof Text) {
    let lastIndex = -1;
    for (let index = 0; index < dom.positions.length; index++) {
      const position = dom.positions[index];
      if (position?.node !== node) continue;
      if (position.offset >= offset) return index;
      lastIndex = index;
    }
    if (lastIndex >= 0) return lastIndex + 1;
  }

  for (let index = 0; index <= dom.text.length; index++) {
    const caret =
      index === dom.text.length
        ? caretAfterLast(dom, dom.positions.length - 1)
        : caretBefore(dom, index);
    if (!caret) continue;
    const comparison = comparePoints(caret, node, offset);
    if (comparison === null) return null;
    if (comparison >= 0) return index;
  }
  return dom.text.length;
}

/** Resolves a [start, end) character range into a DOM Range (collapsed if start === end). */
export function resolveRange(dom: DomText, start: number, end: number): Range | null {
  if (dom.barriers.some((offset) => start < offset && offset < end)) return null;
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
  if (dom.barriers.some((offset) => start < offset && offset < end)) return false;
  if (start === end) {
    const adjacent = [dom.positions[start - 1], dom.positions[start]];
    if (adjacent.some((position) => position?.readonly)) return false;
  } else if (dom.positions.slice(start, end).some((position) => position?.readonly)) {
    return false;
  }

  const range = resolveRange(dom, start, end);
  if (!range) return false;
  return replaceContentEditableRange(dom.root, range, suggestion);
}
