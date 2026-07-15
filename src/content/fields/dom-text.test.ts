import { describe, it, expect, beforeEach } from 'vitest';
import { buildDomText, resolveRange, applyDomEdit } from './dom-text';

function makeRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('contenteditable', 'true');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('buildDomText', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('extracts flat text from a single text node', () => {
    const dom = buildDomText(makeRoot('I has a cat'));
    expect(dom.text).toBe('I has a cat');
    expect(dom.positions).toHaveLength(11);
    expect(dom.positions[0]).not.toBeNull();
  });

  it('joins inline elements within one block without separators', () => {
    const dom = buildDomText(makeRoot('hello <b>world</b>'));
    expect(dom.text).toBe('hello world');
  });

  it('inserts newline separators between block elements', () => {
    const dom = buildDomText(makeRoot('<div>one</div><div>two</div>'));
    expect(dom.text).toBe('one\ntwo');
  });

  it('treats <br> as a newline', () => {
    const dom = buildDomText(makeRoot('a<br>b'));
    expect(dom.text).toBe('a\nb');
  });

  it('keeps protected tokens as read-only context', () => {
    const dom = buildDomText(makeRoot('Hello <span contenteditable="false">@alice</span> today'));
    expect(dom.text).toBe('Hello @alice today');
    expect(dom.positions.slice(6, 12).every((position) => position?.readonly)).toBe(true);
  });

  it('excludes non-rendered subtrees', () => {
    const dom = buildDomText(
      makeRoot(
        'Visible<script>secret()</script><style>.hidden{}</style><span hidden>gone</span> text',
      ),
    );
    expect(dom.text).toBe('Visible text');
  });
});

describe('resolveRange', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves a range covering a word', () => {
    const root = makeRoot('I has a cat');
    const dom = buildDomText(root);
    const range = resolveRange(dom, 2, 5);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('has');
  });

  it('resolves a collapsed range for an insertion point', () => {
    const root = makeRoot('I a cat');
    const dom = buildDomText(root);
    const range = resolveRange(dom, 2, 2);
    expect(range).not.toBeNull();
    expect(range!.collapsed).toBe(true);
  });
});

describe('applyDomEdit', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('replaces a word within a single text node', () => {
    const root = makeRoot('I has a cat');
    const dom = buildDomText(root);
    expect(applyDomEdit(dom, 2, 5, 'has', 'have')).toBe(true);
    expect(root.textContent).toBe('I have a cat');
  });

  it('inserts text at a zero-width position', () => {
    const root = makeRoot('I a cat');
    const dom = buildDomText(root);
    expect(applyDomEdit(dom, 2, 2, '', 'am ')).toBe(true);
    expect(root.textContent).toBe('I am a cat');
  });

  it('replaces across multiple text nodes', () => {
    const root = makeRoot('<b>wo</b><b>rd</b>');
    const dom = buildDomText(root);
    expect(applyDomEdit(dom, 0, 4, 'word', 'W')).toBe(true);
    expect(root.textContent).toBe('W');
  });

  it('preserves surrounding markup when replacing inside one node', () => {
    const root = makeRoot('hello <b>wrld</b> ok');
    const dom = buildDomText(root);
    // "wrld" occupies indices 6..10 in "hello wrld ok"
    expect(dom.text).toBe('hello wrld ok');
    expect(applyDomEdit(dom, 6, 10, 'wrld', 'world')).toBe(true);
    expect(root.querySelector('b')?.textContent).toBe('world');
    expect(root.textContent).toBe('hello world ok');
  });

  it('refuses to apply when the original text no longer matches', () => {
    const root = makeRoot('I has a cat');
    const dom = buildDomText(root);
    expect(applyDomEdit(dom, 2, 5, 'XXX', 'have')).toBe(false);
    expect(root.textContent).toBe('I has a cat');
  });

  it('refuses edits that cross a protected contenteditable token', () => {
    const root = makeRoot('Hello <span contenteditable="false">@alice</span> today');
    const dom = buildDomText(root);
    expect(applyDomEdit(dom, 6, 12, '@alice', '@bob')).toBe(false);
    expect(root.querySelector('[contenteditable="false"]')?.textContent).toBe('@alice');
  });

  it('refuses insertions at a protected token boundary', () => {
    const root = makeRoot('Hello <span contenteditable="false">@alice</span> today');
    const dom = buildDomText(root);
    expect(applyDomEdit(dom, 6, 6, '', 'dear ')).toBe(false);
    expect(root.textContent).toBe('Hello @alice today');
  });

  it('does not delete a hidden subtree crossed by a projected edit', () => {
    const root = makeRoot('a<span hidden>secret</span>b');
    const hidden = root.querySelector('span')!;
    const dom = buildDomText(root);
    expect(dom.text).toBe('ab');
    expect(applyDomEdit(dom, 0, 2, 'ab', 'AB')).toBe(false);
    expect(hidden.isConnected).toBe(true);
    expect(hidden.textContent).toBe('secret');
  });

  it('does not delete a DOM-only protected token crossed by an edit', () => {
    const root = makeRoot('a<span contenteditable="false"><img alt="mention" /></span>b');
    const token = root.querySelector('[contenteditable="false"]')!;
    const dom = buildDomText(root);
    expect(dom.text).toBe('ab');
    expect(applyDomEdit(dom, 0, 2, 'ab', 'AB')).toBe(false);
    expect(token.isConnected).toBe(true);
  });
});
