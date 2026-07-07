import type { Correction } from '../core/types';
import type { FieldAdapter } from './fields/types';
import type { Settings } from '../shared/settings';
import { newRequestId, sendToBackground, type CheckResult } from '../shared/messages';
import { createLogger } from '../shared/logger';
import type { Tooltip } from './tooltip';

const log = createLogger('content');

function wordCount(text: string): number {
  return text.trim().match(/\S+/g)?.length ?? 0;
}

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
  private destroyed = false;

  constructor(
    private readonly adapter: FieldAdapter,
    private settings: Settings,
    private readonly tooltip: Tooltip,
  ) {
    this.adapter.attach({
      onInput: () => this.onEdited(),
      onReflow: () => this.tooltip.hide(),
      onBlur: () => undefined,
    });
    this.adapter.element.addEventListener('mousemove', this.onPointerMove);
    this.adapter.element.addEventListener('mouseleave', this.onPointerLeave);
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
    this.scheduleCheck(400);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    this.adapter.element.removeEventListener('mousemove', this.onPointerMove);
    this.adapter.element.removeEventListener('mouseleave', this.onPointerLeave);
    this.adapter.destroy();
  }

  private scheduleCheck(delay = this.settings.debounceMs): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.check(), delay);
  }

  private async check(): Promise<void> {
    if (this.destroyed) return;
    const text = this.adapter.getText();
    if (wordCount(text) < this.settings.minWords) {
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
    const found = this.correctionAt(event.clientX, event.clientY);
    if (found) {
      this.hovered = found;
      if (!this.tooltip.isShowing(found)) {
        const rect = this.adapter.rectFor(found.start, found.end);
        if (rect) {
          this.tooltip.show(rect, found, {
            onAccept: (c) => this.apply(c),
            onIgnore: (c) => this.ignore(c),
          });
        }
      }
    } else if (this.hovered) {
      this.hovered = null;
      this.tooltip.scheduleHide();
    }
  };

  private readonly onPointerLeave = (event: MouseEvent): void => {
    if (!this.tooltip.contains(event.relatedTarget)) this.tooltip.scheduleHide();
  };

  private correctionAt(x: number, y: number): Correction | null {
    for (const correction of this.corrections) {
      const rect = this.adapter.rectFor(correction.start, correction.end);
      if (
        rect &&
        x >= rect.left - 2 &&
        x <= rect.right + 2 &&
        y >= rect.top - 2 &&
        y <= rect.bottom + 2
      ) {
        return correction;
      }
    }
    return null;
  }

  private apply(correction: Correction): void {
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
