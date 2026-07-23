import type { Correction } from '../../core/types';
import type { CorrectionRect, FieldAdapter, FieldHandlers, FieldKind } from './types';
import {
  buildDomText,
  resolveRange,
  applyDomEdit,
  domOffsetForPoint,
  type DomText,
} from './dom-text';
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
  private readonly useApi: boolean;
  private readonly highlights = new HighlightSet();
  private readonly overlay: Overlay | null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly reposition: RafThrottle = rafThrottle(() => this.reflow());
  private readonly disposers: Array<() => void> = [];

  constructor(readonly element: HTMLElement) {
    this.dom = buildDomText(element);
    // Document highlight rules do not cross a shadow boundary. Use the
    // viewport overlay there so corrections remain visible.
    this.useApi = supportsHighlightApi() && !(element.getRootNode() instanceof ShadowRoot);
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
    const forward = resolveRange(this.dom, start, Math.min(len, end + 1));
    if (forward && !forward.collapsed) return forward;
    const backward = resolveRange(this.dom, Math.max(0, start - 1), start);
    return backward && !backward.collapsed ? backward : null;
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
    const range = this.displayRange(start, end);
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0 ? null : rect;
  }

  applyEdit(start: number, end: number, expectedOriginal: string, suggestion: string): boolean {
    this.dom = buildDomText(this.element);
    const selection = window.getSelection();
    const selectionOffsets =
      selection?.anchorNode &&
      selection.focusNode &&
      this.element.contains(selection.anchorNode) &&
      this.element.contains(selection.focusNode)
        ? {
            anchor: domOffsetForPoint(this.dom, selection.anchorNode, selection.anchorOffset),
            focus: domOffsetForPoint(this.dom, selection.focusNode, selection.focusOffset),
          }
        : null;
    const ok = applyDomEdit(this.dom, start, end, expectedOriginal, suggestion);
    if (ok) {
      this.dom = buildDomText(this.element);
      if (
        selection &&
        selectionOffsets?.anchor !== null &&
        selectionOffsets?.focus !== null &&
        selectionOffsets
      ) {
        const delta = suggestion.length - (end - start);
        const adjust = (position: number): number => {
          if (position < start) return position;
          if (position >= end) return position + delta;
          if (position === start) return start;
          return start + suggestion.length;
        };
        const anchor = resolveRange(
          this.dom,
          adjust(selectionOffsets.anchor),
          adjust(selectionOffsets.anchor),
        );
        const focus = resolveRange(
          this.dom,
          adjust(selectionOffsets.focus),
          adjust(selectionOffsets.focus),
        );
        if (anchor && focus) {
          selection.setBaseAndExtent(
            anchor.startContainer,
            anchor.startOffset,
            focus.startContainer,
            focus.startOffset,
          );
        }
      }
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
      this.resizeObserver = new ResizeObserver(() => {
        this.reposition.schedule();
        handlers.onReflow();
      });
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
