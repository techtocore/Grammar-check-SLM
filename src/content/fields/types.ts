import type { Correction } from '../../core/types';

export type FieldKind = 'contenteditable' | 'textinput';

/** A correction paired with its current viewport rectangle. */
export interface CorrectionRect {
  correction: Correction;
  rect: DOMRect;
}

export interface FieldHandlers {
  /** Fired when the field's text changes (debounced by the controller). */
  onInput(): void;
  /** Fired when the field scrolls/resizes and overlays must be repositioned. */
  onReflow(): void;
  /** Fired when the field loses focus. */
  onBlur(): void;
}

/**
 * A uniform interface over the different kinds of editable fields
 * (contenteditable elements vs. <textarea>/<input>). Encapsulates text
 * extraction, offset→geometry mapping, highlight rendering, and applying edits.
 */
export interface FieldAdapter {
  readonly element: HTMLElement;
  readonly kind: FieldKind;

  /** Current plain text of the field (the exact string offsets refer to). */
  getText(): string;

  /** Renders underlines for the given corrections (offsets into getText()). */
  showCorrections(corrections: Correction[]): void;

  /** Removes all rendered highlights. */
  clear(): void;

  /**
   * Viewport-relative rectangle for a correction range, used to position the
   * suggestion tooltip. Returns null if it cannot be resolved.
   */
  rectFor(start: number, end: number): DOMRect | null;

  /**
   * Cached viewport rectangles for the current corrections, refreshed whenever
   * the field is shown, scrolled, or resized. Used for pointer hit-testing so
   * hovering never forces a layout on every mouse move.
   */
  correctionRects(): readonly CorrectionRect[];

  /**
   * Applies an edit to the field, replacing [start, end) with `suggestion`.
   * `expectedOriginal` guards against stale offsets. Returns true on success.
   */
  applyEdit(start: number, end: number, expectedOriginal: string, suggestion: string): boolean;

  /** Wires up input/scroll/blur listeners. */
  attach(handlers: FieldHandlers): void;

  /** Tears down listeners and DOM artifacts. */
  destroy(): void;
}

export type { Correction };
