import type { Correction } from '../../core/types';
import type { CorrectionRect, FieldAdapter, FieldHandlers, FieldKind } from './types';
import { buildDomText, resolveRange, applyDomEdit, type DomText } from './dom-text';
import { HighlightSet, Overlay, supportsHighlightApi } from '../highlighter';
import { rafThrottle, type RafThrottle } from '../schedule';
import { isElementVisible } from './visibility';

/** Adapter for `contenteditable` elements (Gmail, chat boxes, rich editors, …). */
export class ContentEditableAdapter implements FieldAdapter {
  readonly kind: FieldKind = 'contenteditable';

  private dom: DomText;
  private corrections: Correction[] = [];
  private rects: CorrectionRect[] = [];
  private handlers: FieldHandlers | null = null;
  private readonly useApi = supportsHighlightApi();
  private readonly highlights = new HighlightSet();
  private readonly overlay: Overlay | null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly reposition: RafThrottle = rafThrottle(() => this.reflow());
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
        .map((c) => this.displayRange(c.start, c.end))
        .filter((r): r is Range => r !== null && !r.collapsed);
      this.highlights.set(ranges);
    }
    // Refresh the hit-test cache (and, on the fallback path, the overlay). With
    // the Highlight API the underlines track text automatically, but the cached
    // rects still need refreshing for hover after scroll/resize.
    this.reflow();
  }

  correctionRects(): readonly CorrectionRect[] {
    return this.rects;
  }

  /** A non-collapsed range for highlighting; zero-width insertions are widened
   * to an adjacent character so missing-word suggestions are still visible. */
  private displayRange(start: number, end: number): Range | null {
    if (start !== end) return resolveRange(this.dom, start, end);
    const len = this.dom.text.length;
    return (
      resolveRange(this.dom, start, Math.min(len, end + 1)) ??
      resolveRange(this.dom, Math.max(0, start - 1), start)
    );
  }

  clear(): void {
    this.corrections = [];
    this.rects = [];
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
      this.reposition.schedule();
      handlers.onReflow();
    };
    this.element.addEventListener('input', onInput);
    this.element.addEventListener('blur', onBlur);
    // Passive listeners never block scrolling; work is deferred to one rAF.
    window.addEventListener('scroll', onReflow, { capture: true, passive: true });
    window.addEventListener('resize', onReflow, { passive: true });
    // The visual viewport moves independently of the layout viewport on pinch-
    // zoom and when the mobile keyboard opens; track it so overlays stay aligned.
    const vv = window.visualViewport;
    vv?.addEventListener('scroll', onReflow, { passive: true });
    vv?.addEventListener('resize', onReflow, { passive: true });
    // Editors that grow/shrink (auto-resize composers, resizable panes) fire no
    // scroll/resize event; a ResizeObserver keeps the cache and overlay honest
    // (and covers size-changing animations without a noisy global transitionend
    // listener that would fire for every unrelated transition on the page).
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.reposition.schedule());
      this.resizeObserver.observe(this.element);
    }
    this.disposers.push(
      () => this.element.removeEventListener('input', onInput),
      () => this.element.removeEventListener('blur', onBlur),
      () => window.removeEventListener('scroll', onReflow, true),
      () => window.removeEventListener('resize', onReflow),
      () => vv?.removeEventListener('scroll', onReflow),
      () => vv?.removeEventListener('resize', onReflow),
    );
  }

  destroy(): void {
    this.reposition.cancel();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.clear();
    this.overlay?.destroy();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.handlers = null;
  }

  /** Rebuilds the hit-test rect cache and repaints the overlay (fallback path). */
  private reflow(): void {
    if (!isElementVisible(this.element)) {
      this.rects = [];
      this.overlay?.clear();
      return;
    }
    const rects: CorrectionRect[] = [];
    for (const correction of this.corrections) {
      const rect = this.rectFor(correction.start, correction.end);
      if (rect) rects.push({ correction, rect });
    }
    this.rects = rects;
    if (this.overlay) this.overlay.setRects(rects.map((entry) => entry.rect));
  }
}
