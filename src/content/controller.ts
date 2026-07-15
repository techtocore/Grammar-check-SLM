import type { Correction } from '../core/types';
import type { CorrectionRect, FieldAdapter } from './fields/types';
import type { Settings } from '../shared/settings';
import { newRequestId, sendToBackground, type CheckResult } from '../shared/messages';
import { createLogger } from '../shared/logger';
import { extensionContextValid, invalidateContext, isContextInvalidationError } from './lifecycle';
import type { Tooltip } from './tooltip';
import { fieldKindFor } from './fields/eligibility';
import { countWords } from '../core/tokenize';

const log = createLogger('content');

function ignoreKey(correction: Correction): string {
  return `${correction.original}\u0000${correction.suggestion}`;
}

/**
 * Drives grammar checking for a single field: debounced checks, stale-response
 * rejection, highlight rendering, hover→tooltip, and applying/ignoring edits.
 */
export class FieldController {
  private corrections: Correction[] = [];
  private readonly ignored = new Set<string>();
  private debounceTimer: number | null = null;
  private recheckTimer: number | null = null;
  private requestSeq = 0;
  private hovered: Correction | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private pointerRaf = 0;
  private destroyed = false;

  constructor(
    private readonly adapter: FieldAdapter,
    private settings: Settings,
    private readonly tooltip: Tooltip,
    private readonly origin: string | null = null,
  ) {
    this.adapter.attach({
      onInput: () => this.onEdited(),
      onReflow: () => this.tooltip.hide(),
      onBlur: () => undefined,
    });
    this.adapter.element.addEventListener('mousemove', this.onPointerMove, { passive: true });
    this.adapter.element.addEventListener('mouseleave', this.onPointerLeave, { passive: true });
    // Touch/pen devices have no hover, so a tap reveals the suggestion instead.
    this.adapter.element.addEventListener('pointerup', this.onPointerTap, { passive: true });
    // Check any pre-existing content shortly after attach.
    this.scheduleCheck(400);
  }

  /** Called on every edit: drop now-stale highlights/tooltip, then debounce a check. */
  private onEdited(): void {
    this.requestSeq++; // invalidate any in-flight response
    this.tooltip.hide();
    if (this.corrections.length > 0) this.setCorrections([]);
    this.scheduleCheck();
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.requestSeq++;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.recheckTimer !== null) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
    this.tooltip.hide();
    if (this.corrections.length > 0) this.setCorrections([]);
  }

  destroy(): void {
    this.destroyed = true;
    this.tooltip.hide();
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    if (this.pointerRaf !== 0) cancelAnimationFrame(this.pointerRaf);
    this.adapter.element.removeEventListener('mousemove', this.onPointerMove);
    this.adapter.element.removeEventListener('mouseleave', this.onPointerLeave);
    this.adapter.element.removeEventListener('pointerup', this.onPointerTap);
    this.adapter.destroy();
  }

  private scheduleCheck(delay = this.settings.debounceMs): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.check(), delay);
  }

  private async check(): Promise<void> {
    if (this.destroyed) return;
    // Revalidate before reading the value. Attribute changes inside a shadow
    // root are invisible to the document observer, and a text field may have
    // become password/readonly since it was attached.
    if (
      !this.adapter.element.isConnected ||
      fieldKindFor(this.adapter.element, this.settings) !== this.adapter.kind
    ) {
      this.setCorrections([]);
      return;
    }
    // The extension may have been reloaded/updated while this page stayed open,
    // leaving this content script orphaned. Detect that and shut down cleanly
    // instead of repeatedly failing to message a gone service worker.
    if (!extensionContextValid()) {
      invalidateContext();
      return;
    }
    const text = this.adapter.getText();
    if (countWords(text, this.settings.language) < this.settings.minWords) {
      this.setCorrections([]);
      return;
    }

    const seq = ++this.requestSeq;
    let result: CheckResult;
    try {
      result = await sendToBackground<CheckResult>({
        type: 'check',
        target: 'background',
        requestId: newRequestId(),
        text,
      });
    } catch (error) {
      if (isContextInvalidationError(error)) {
        invalidateContext();
        return;
      }
      log.warn('Grammar check request failed.', error);
      return;
    }

    if (this.destroyed || seq !== this.requestSeq) return;
    // Discard if the field changed while we were waiting.
    if (this.adapter.getText() !== result.sourceText) return;

    if (result.error) log.warn('Grammar check returned an error:', result.error);
    const filtered = result.corrections.filter((c) => !this.ignored.has(ignoreKey(c)));
    log.debug(`Checked ${text.length} chars → ${filtered.length} suggestion(s).`);
    this.setCorrections(filtered);
  }

  private setCorrections(corrections: Correction[]): void {
    this.corrections = corrections;
    if (corrections.length === 0) this.adapter.clear();
    else this.adapter.showCorrections(corrections);
  }

  private readonly onPointerMove = (event: MouseEvent): void => {
    // Record the position and coalesce hit-testing into one rAF, so moving the
    // mouse never reads layout more than once per frame regardless of event rate.
    this.lastPointer = { x: event.clientX, y: event.clientY };
    if (this.pointerRaf !== 0) return;
    this.pointerRaf = requestAnimationFrame(() => {
      this.pointerRaf = 0;
      this.processPointer();
    });
  };

  private processPointer(): void {
    if (this.destroyed) return;
    const pointer = this.lastPointer;
    if (!pointer) return;
    const hit = this.hitTest(pointer.x, pointer.y);
    if (hit) {
      this.hovered = hit.correction;
      // Cancel any pending hide so pointing at the word keeps the card up even
      // after a momentary move off it (or off the card and back).
      this.tooltip.cancelHide();
      if (!this.tooltip.isShowing(hit.correction)) {
        this.tooltip.show(hit.rect, hit.correction, {
          onAccept: (c) => this.apply(c),
          onIgnore: (c) => this.ignore(c),
        });
      }
    } else if (this.hovered) {
      this.hovered = null;
      this.tooltip.scheduleHide();
    }
  }

  private readonly onPointerLeave = (event: MouseEvent): void => {
    // Drop any queued hit-test so leaving the field can't re-show the tooltip
    // from a stale, inside-the-field pointer position.
    if (this.pointerRaf !== 0) {
      cancelAnimationFrame(this.pointerRaf);
      this.pointerRaf = 0;
    }
    this.lastPointer = null;
    if (!this.tooltip.contains(event.relatedTarget)) this.tooltip.scheduleHide();
  };

  private readonly onPointerTap = (event: PointerEvent): void => {
    // Mouse uses hover (mousemove); this is only for touch/pen taps.
    if (event.pointerType === 'mouse') return;
    const hit = this.hitTest(event.clientX, event.clientY);
    if (hit) {
      this.hovered = hit.correction;
      this.tooltip.show(hit.rect, hit.correction, {
        onAccept: (c) => this.apply(c),
        onIgnore: (c) => this.ignore(c),
      });
    } else {
      this.hovered = null;
      this.tooltip.hide();
    }
  };

  /**
   * Finds the correction under the pointer using the adapter's cached rects.
   * Pure arithmetic — no layout is read on the pointer path at all.
   */
  private hitTest(x: number, y: number): CorrectionRect | null {
    for (const entry of this.adapter.correctionRects()) {
      const r = entry.rect;
      if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) {
        return entry;
      }
    }
    return null;
  }

  private apply(correction: Correction): void {
    if (
      !this.adapter.element.isConnected ||
      fieldKindFor(this.adapter.element, this.settings) !== this.adapter.kind
    ) {
      this.tooltip.hide();
      this.setCorrections([]);
      return;
    }
    const ok = this.adapter.applyEdit(
      correction.start,
      correction.end,
      correction.original,
      correction.suggestion,
    );
    if (!ok) return;
    this.corrections = this.corrections.filter((c) => c !== correction);
    this.adapter.clear();
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    this.recheckTimer = window.setTimeout(() => void this.check(), 300);
  }

  private ignore(correction: Correction): void {
    this.ignored.add(ignoreKey(correction));
    this.setCorrections(this.corrections.filter((c) => c !== correction));
  }
}
