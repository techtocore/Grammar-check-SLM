import type { Correction } from '../../core/types';
import type { CorrectionRect, FieldAdapter, FieldHandlers, FieldKind } from './types';
import { Overlay } from '../highlighter';
import { rafThrottle, type RafThrottle } from '../schedule';
import { isElementVisible } from './visibility';

type TextField = HTMLInputElement | HTMLTextAreaElement;

// Computed-style properties copied to the measuring mirror so it lays text out
// identically to the real field.
const MIRROR_STYLE_PROPS = [
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'textIndent',
  'lineHeight',
  'tabSize',
] as const;

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

interface MeasureContext {
  computed: CSSStyleDeclaration;
  fieldRect: DOMRect;
  borderLeft: number;
  borderTop: number;
}

/** Adapter for `<input>` and `<textarea>` fields, using a mirror to locate text. */
export class TextInputAdapter implements FieldAdapter {
  readonly kind: FieldKind = 'textinput';

  private readonly field: TextField;
  private corrections: Correction[] = [];
  private rects: CorrectionRect[] = [];
  private handlers: FieldHandlers | null = null;
  private readonly overlay = new Overlay();
  private mirror: HTMLDivElement | null = null;
  private mirrorBefore: Text | null = null;
  private mirrorMarker: HTMLSpanElement | null = null;
  private mirrorAfter: Text | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly reposition: RafThrottle = rafThrottle(() => this.repositionNow());
  private readonly disposers: Array<() => void> = [];

  constructor(element: HTMLElement) {
    this.field = element as TextField;
  }

  get element(): HTMLElement {
    return this.field;
  }

  getText(): string {
    return this.field.value;
  }

  showCorrections(corrections: Correction[]): void {
    this.corrections = corrections;
    this.repositionNow();
  }

  clear(): void {
    this.corrections = [];
    this.rects = [];
    this.overlay.clear();
  }

  correctionRects(): readonly CorrectionRect[] {
    return this.rects;
  }

  rectFor(start: number, end: number): DOMRect | null {
    try {
      const ctx = this.measureContext();
      if (!ctx) return null;
      this.prepareMirror(ctx.computed);
      return this.locate(start, end, ctx);
    } catch {
      return this.field.getBoundingClientRect();
    }
  }

  applyEdit(start: number, end: number, expectedOriginal: string, suggestion: string): boolean {
    const value = this.field.value;
    if (start < 0 || end > value.length || start > end) return false;
    if (value.slice(start, end) !== expectedOriginal) return false;

    const next = value.slice(0, start) + suggestion + value.slice(end);
    setNativeValue(this.field, next);
    const caret = start + suggestion.length;
    try {
      this.field.setSelectionRange(caret, caret);
    } catch {
      /* some input types disallow selection */
    }
    this.field.dispatchEvent(new Event('input', { bubbles: true }));
    this.field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  attach(handlers: FieldHandlers): void {
    this.handlers = handlers;
    const onInput = (): void => handlers.onInput();
    const onBlur = (): void => handlers.onBlur();
    const onReflow = (): void => {
      this.reposition.schedule();
      handlers.onReflow();
    };
    this.field.addEventListener('input', onInput);
    this.field.addEventListener('blur', onBlur);
    // Passive listeners never block scrolling; the work is deferred to one rAF.
    this.field.addEventListener('scroll', onReflow, { passive: true });
    window.addEventListener('scroll', onReflow, { capture: true, passive: true });
    window.addEventListener('resize', onReflow, { passive: true });
    // The visual viewport moves independently of the layout viewport on pinch-
    // zoom and when the mobile keyboard opens; track it so overlays stay aligned.
    const vv = window.visualViewport;
    vv?.addEventListener('scroll', onReflow, { passive: true });
    vv?.addEventListener('resize', onReflow, { passive: true });
    // Catches the textarea resize handle and programmatic size changes, which
    // fire no scroll/resize event of their own. This also covers size-changing
    // CSS animations without the noise of a global transitionend/animationend
    // listener (which fires for every unrelated transition on the page).
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.reposition.schedule());
      this.resizeObserver.observe(this.field);
    }
    this.disposers.push(
      () => this.field.removeEventListener('input', onInput),
      () => this.field.removeEventListener('blur', onBlur),
      () => this.field.removeEventListener('scroll', onReflow),
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
    this.overlay.destroy();
    this.mirror?.remove();
    this.mirror = null;
    this.mirrorBefore = null;
    this.mirrorMarker = null;
    this.mirrorAfter = null;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.handlers = null;
  }

  /** Recomputes every correction's rect in one batched layout pass and repaints. */
  private repositionNow(): void {
    const ctx = this.measureContext();
    if (!ctx) {
      // Hidden/detached — drop stale marks rather than draw them at (0, 0).
      this.rects = [];
      this.overlay.clear();
      return;
    }
    this.prepareMirror(ctx.computed);
    const rects: CorrectionRect[] = [];
    for (const correction of this.corrections) {
      const rect = this.locate(correction.start, correction.end, ctx);
      if (rect) rects.push({ correction, rect });
    }
    this.rects = rects;
    this.overlay.setRects(rects.map((entry) => entry.rect));
  }

  /** Single shared read pass; returns null when the field isn't visible. */
  private measureContext(): MeasureContext | null {
    const field = this.field;
    if (!isElementVisible(field)) return null;
    const fieldRect = field.getBoundingClientRect();
    if (fieldRect.width === 0 && fieldRect.height === 0) return null;
    const computed = window.getComputedStyle(field);
    return {
      computed,
      fieldRect,
      borderLeft: parseFloat(computed.borderLeftWidth || '0'),
      borderTop: parseFloat(computed.borderTopWidth || '0'),
    };
  }

  private prepareMirror(computed: CSSStyleDeclaration): void {
    const mirror = this.ensureMirror();
    const isTextarea = this.field instanceof HTMLTextAreaElement;
    mirror.style.whiteSpace = isTextarea ? 'pre-wrap' : 'pre';
    mirror.style.overflowWrap = isTextarea ? 'break-word' : 'normal';
    for (const prop of MIRROR_STYLE_PROPS) {
      mirror.style[prop] = computed[prop];
    }
    const paddingX =
      parseFloat(computed.paddingLeft || '0') + parseFloat(computed.paddingRight || '0');
    mirror.style.width = `${Math.max(0, this.field.clientWidth - paddingX)}px`;
  }

  /** Positions the reused marker inside the prepared mirror and reads its rect. */
  private locate(start: number, end: number, ctx: MeasureContext): DOMRect | null {
    const field = this.field;
    const value = field.value;
    const clampedStart = Math.max(0, Math.min(start, value.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, value.length));

    const before = this.mirrorBefore;
    const marker = this.mirrorMarker;
    const after = this.mirrorAfter;
    if (!before || !marker || !after) return null;
    before.data = value.slice(0, clampedStart);
    marker.textContent = value.slice(clampedStart, clampedEnd) || '\u200b';
    after.data = value.slice(clampedEnd);

    const x = ctx.fieldRect.left + ctx.borderLeft + marker.offsetLeft - field.scrollLeft;
    const y = ctx.fieldRect.top + ctx.borderTop + marker.offsetTop - field.scrollTop;
    return new DOMRect(x, y, marker.offsetWidth, marker.offsetHeight);
  }

  private ensureMirror(): HTMLDivElement {
    if (this.mirror) return this.mirror;
    const mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    const style = mirror.style;
    style.position = 'absolute';
    style.top = '0';
    style.left = '-9999px';
    style.visibility = 'hidden';
    style.pointerEvents = 'none';
    style.margin = '0';
    style.border = '0';
    style.boxSizing = 'content-box';
    style.overflow = 'hidden';
    // Persistent child nodes, reused across measurements (no per-pass allocation).
    this.mirrorBefore = document.createTextNode('');
    this.mirrorMarker = document.createElement('span');
    this.mirrorAfter = document.createTextNode('');
    mirror.append(this.mirrorBefore, this.mirrorMarker, this.mirrorAfter);
    document.body.appendChild(mirror);
    this.mirror = mirror;
    return mirror;
  }
}
