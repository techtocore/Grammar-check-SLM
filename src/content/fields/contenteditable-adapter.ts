import type { Correction } from '../../core/types';
import type { FieldAdapter, FieldHandlers, FieldKind } from './types';
import { buildDomText, resolveRange, applyDomEdit, type DomText } from './dom-text';
import { HighlightSet, Overlay, supportsHighlightApi } from '../highlighter';

/** Adapter for `contenteditable` elements (Gmail, chat boxes, rich editors, …). */
export class ContentEditableAdapter implements FieldAdapter {
  readonly kind: FieldKind = 'contenteditable';

  private dom: DomText;
  private corrections: Correction[] = [];
  private handlers: FieldHandlers | null = null;
  private readonly useApi = supportsHighlightApi();
  private readonly highlights = new HighlightSet();
  private readonly overlay: Overlay | null;
  private readonly disposers: Array<() => void> = [];

  constructor(readonly element: HTMLElement) {
    this.dom = buildDomText(element);
    this.overlay = this.useApi ? null : new Overlay();
  }

  getText(): string {
    this.dom = buildDomText(this.element);
    return this.dom.text;
  }

  showCorrections(corrections: Correction[]): void {
    this.corrections = corrections;
    this.dom = buildDomText(this.element);
    if (this.useApi) {
      const ranges = corrections
        .map((c) => resolveRange(this.dom, c.start, c.end))
        .filter((r): r is Range => r !== null && !r.collapsed);
      this.highlights.set(ranges);
    } else {
      this.repositionOverlay();
    }
  }

  clear(): void {
    this.corrections = [];
    this.highlights.clear();
    this.overlay?.clear();
  }

  rectFor(start: number, end: number): DOMRect | null {
    // Uses the cached snapshot (rebuilt on input/showCorrections); scrolling
    // does not change node offsets, only viewport coordinates.
    const range =
      start === end
        ? (resolveRange(this.dom, start, Math.min(this.dom.text.length, end + 1)) ??
          resolveRange(this.dom, start, end))
        : resolveRange(this.dom, start, end);
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0 ? null : rect;
  }

  applyEdit(start: number, end: number, expectedOriginal: string, suggestion: string): boolean {
    this.dom = buildDomText(this.element);
    const ok = applyDomEdit(this.dom, start, end, expectedOriginal, suggestion);
    if (ok) {
      this.element.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return ok;
  }

  attach(handlers: FieldHandlers): void {
    this.handlers = handlers;
    const onInput = (): void => handlers.onInput();
    const onBlur = (): void => handlers.onBlur();
    const onReflow = (): void => {
      this.repositionOverlay();
      handlers.onReflow();
    };
    this.element.addEventListener('input', onInput);
    this.element.addEventListener('blur', onBlur);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    this.disposers.push(
      () => this.element.removeEventListener('input', onInput),
      () => this.element.removeEventListener('blur', onBlur),
      () => window.removeEventListener('scroll', onReflow, true),
      () => window.removeEventListener('resize', onReflow),
    );
  }

  destroy(): void {
    this.clear();
    this.overlay?.destroy();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.handlers = null;
  }

  private repositionOverlay(): void {
    if (!this.overlay) return;
    const rects: DOMRect[] = [];
    for (const c of this.corrections) {
      const rect = this.rectFor(c.start, c.end);
      if (rect) rects.push(rect);
    }
    this.overlay.setRects(rects);
  }
}
