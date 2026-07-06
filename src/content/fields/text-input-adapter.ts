import type { Correction } from '../../core/types';
import type { FieldAdapter, FieldHandlers, FieldKind } from './types';
import { Overlay } from '../highlighter';

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

/** Adapter for `<input>` and `<textarea>` fields, using a mirror to locate text. */
export class TextInputAdapter implements FieldAdapter {
  readonly kind: FieldKind = 'textinput';

  private readonly field: TextField;
  private corrections: Correction[] = [];
  private handlers: FieldHandlers | null = null;
  private readonly overlay = new Overlay();
  private mirror: HTMLDivElement | null = null;
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
    this.repositionOverlay();
  }

  clear(): void {
    this.corrections = [];
    this.overlay.clear();
  }

  rectFor(start: number, end: number): DOMRect | null {
    try {
      return this.measure(start, end);
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
      this.repositionOverlay();
      handlers.onReflow();
    };
    this.field.addEventListener('input', onInput);
    this.field.addEventListener('blur', onBlur);
    this.field.addEventListener('scroll', onReflow);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    this.disposers.push(
      () => this.field.removeEventListener('input', onInput),
      () => this.field.removeEventListener('blur', onBlur),
      () => this.field.removeEventListener('scroll', onReflow),
      () => window.removeEventListener('scroll', onReflow, true),
      () => window.removeEventListener('resize', onReflow),
    );
  }

  destroy(): void {
    this.clear();
    this.overlay.destroy();
    this.mirror?.remove();
    this.mirror = null;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.handlers = null;
  }

  private repositionOverlay(): void {
    const rects: DOMRect[] = [];
    for (const c of this.corrections) {
      const rect = this.measure(c.start, c.end);
      if (rect) rects.push(rect);
    }
    this.overlay.setRects(rects);
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
    document.body.appendChild(mirror);
    this.mirror = mirror;
    return mirror;
  }

  private measure(start: number, end: number): DOMRect | null {
    const field = this.field;
    const value = field.value;
    const clampedStart = Math.max(0, Math.min(start, value.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, value.length));

    const mirror = this.ensureMirror();
    const computed = window.getComputedStyle(field);

    const isTextarea = field instanceof HTMLTextAreaElement;
    mirror.style.whiteSpace = isTextarea ? 'pre-wrap' : 'pre';
    mirror.style.overflowWrap = isTextarea ? 'break-word' : 'normal';
    for (const prop of MIRROR_STYLE_PROPS) {
      mirror.style[prop] = computed[prop];
    }
    const paddingX =
      parseFloat(computed.paddingLeft || '0') + parseFloat(computed.paddingRight || '0');
    mirror.style.width = `${field.clientWidth - paddingX}px`;

    const marker = document.createElement('span');
    marker.textContent = value.slice(clampedStart, clampedEnd) || '\u200b';
    mirror.replaceChildren(
      document.createTextNode(value.slice(0, clampedStart)),
      marker,
      document.createTextNode(value.slice(clampedEnd)),
    );

    const rect = field.getBoundingClientRect();
    const borderLeft = parseFloat(computed.borderLeftWidth || '0');
    const borderTop = parseFloat(computed.borderTopWidth || '0');
    const x = rect.left + borderLeft + marker.offsetLeft - field.scrollLeft;
    const y = rect.top + borderTop + marker.offsetTop - field.scrollTop;
    return new DOMRect(x, y, marker.offsetWidth, marker.offsetHeight);
  }
}
