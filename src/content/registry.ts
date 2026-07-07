import { ContentEditableAdapter } from './fields/contenteditable-adapter';
import { TextInputAdapter } from './fields/text-input-adapter';
import { FieldController } from './controller';
import type { Tooltip } from './tooltip';
import type { FieldKind } from './fields/types';
import type { Settings } from '../shared/settings';
import { sendToBackground } from '../shared/messages';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);

/**
 * Discovers editable fields lazily (on focus), attaches controllers, and cleans
 * them up when elements are removed or settings disable a field kind.
 */
export class FieldRegistry {
  private readonly controllers = new Map<HTMLElement, FieldController>();
  private observer: MutationObserver | null = null;
  private started = false;
  private warmedUp = false;

  constructor(
    private settings: Settings,
    private readonly tooltip: Tooltip,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    document.addEventListener('focusin', this.onFocusIn, true);
    if (document.activeElement instanceof HTMLElement) this.maybeAttach(document.activeElement);
    this.scanExisting();
    this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'type', 'readonly', 'disabled'],
    });
  }

  /** Attaches to editable fields already present on the page (e.g. pre-filled). */
  private scanExisting(): void {
    const candidates = document.querySelectorAll<HTMLElement>(
      '[contenteditable=""],[contenteditable="true"],textarea,input',
    );
    let count = 0;
    for (const element of candidates) {
      if (count >= 40) break;
      if (!this.kindFor(element)) continue;
      // Skip hidden fields (but always include the focused one).
      if (element.offsetParent === null && element !== document.activeElement) continue;
      this.maybeAttach(element);
      count++;
    }
  }

  stop(): void {
    this.started = false;
    document.removeEventListener('focusin', this.onFocusIn, true);
    this.observer?.disconnect();
    this.observer = null;
    for (const controller of this.controllers.values()) controller.destroy();
    this.controllers.clear();
    this.tooltip.hide();
  }

  updateSettings(settings: Settings, enabled: boolean): void {
    this.settings = settings;
    if (!enabled) {
      this.stop();
      return;
    }
    if (!this.started) this.start();
    for (const [element, controller] of [...this.controllers]) {
      if (!this.kindFor(element)) {
        controller.destroy();
        this.controllers.delete(element);
      } else {
        controller.updateSettings(settings);
      }
    }
  }

  private readonly onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof HTMLElement) this.maybeAttach(event.target);
  };

  private onMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const target = mutation.target;
        // A field may have become ineligible (e.g. <input> changed to password,
        // or contenteditable/readonly/disabled toggled). Stop checking it.
        if (
          target instanceof HTMLElement &&
          this.controllers.has(target) &&
          !this.kindFor(target)
        ) {
          this.controllers.get(target)?.destroy();
          this.controllers.delete(target);
        }
        continue;
      }
      for (const node of mutation.removedNodes) {
        if (node instanceof HTMLElement) this.cleanupRemoved(node);
      }
    }
  }

  private cleanupRemoved(removed: HTMLElement): void {
    for (const [element, controller] of [...this.controllers]) {
      if (removed === element || removed.contains(element)) {
        controller.destroy();
        this.controllers.delete(element);
      }
    }
  }

  private maybeAttach(element: HTMLElement): void {
    if (this.controllers.has(element)) return;
    const kind = this.kindFor(element);
    if (!kind) return;
    const adapter =
      kind === 'contenteditable'
        ? new ContentEditableAdapter(element)
        : new TextInputAdapter(element);
    this.controllers.set(element, new FieldController(adapter, this.settings, this.tooltip));
    this.warmup();
  }

  private kindFor(element: HTMLElement): FieldKind | null {
    if (this.settings.checkContentEditable) {
      const attr = element.getAttribute('contenteditable');
      if ((attr === '' || attr === 'true') && element.isContentEditable) {
        return 'contenteditable';
      }
    }
    if (this.settings.checkTextInputs) {
      if (element instanceof HTMLTextAreaElement && !element.readOnly && !element.disabled) {
        return 'textinput';
      }
      if (
        element instanceof HTMLInputElement &&
        TEXT_INPUT_TYPES.has(element.type) &&
        !element.readOnly &&
        !element.disabled
      ) {
        return 'textinput';
      }
    }
    return null;
  }

  private warmup(): void {
    if (this.warmedUp) return;
    this.warmedUp = true;
    void sendToBackground({ type: 'warmup', target: 'background' }).catch(() => undefined);
  }
}
