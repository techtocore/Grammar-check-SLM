import { ContentEditableAdapter } from './fields/contenteditable-adapter';
import { TextInputAdapter } from './fields/text-input-adapter';
import { FieldController } from './controller';
import type { Tooltip } from './tooltip';
import type { FieldKind } from './fields/types';
import { isElementVisible } from './fields/visibility';
import type { Settings } from '../shared/settings';
import { sendToBackground } from '../shared/messages';
import { invalidateContext, isContextInvalidationError } from './lifecycle';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);

/** The genuinely focused element, descending through open shadow roots. */
function deepActiveElement(root: DocumentOrShadowRoot = document): Element | null {
  const active = root.activeElement;
  if (active?.shadowRoot) return deepActiveElement(active.shadowRoot) ?? active;
  return active;
}

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
    private readonly origin: string | null,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    document.addEventListener('focusin', this.onFocusIn, true);
    const active = deepActiveElement();
    if (active instanceof HTMLElement) this.maybeAttach(active);
    this.scanExisting();
    this.syncObserver();
  }

  /**
   * Runs the page-wide MutationObserver only while we actually have fields to
   * watch for removal. On the vast majority of pages nothing is being checked at
   * any given moment, so this keeps our DOM-observation cost at exactly zero
   * until the user focuses an editable field.
   */
  private syncObserver(): void {
    if (this.controllers.size > 0) {
      if (!this.observer) {
        this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
        this.observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['contenteditable', 'type', 'readonly', 'disabled'],
        });
      }
    } else if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
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
      if (element !== document.activeElement && !isElementVisible(element)) continue;
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
    this.syncObserver();
  }

  private readonly onFocusIn = (event: FocusEvent): void => {
    // Fields removed from inside a shadow tree aren't reported by the
    // documentElement observer, so reconcile on focus changes as a safety net.
    if (this.pruneDisconnected()) this.syncObserver();
    // composedPath()[0] is the real focused node even inside an open shadow root
    // (event.target is retargeted to the shadow host). This lets us check fields
    // rendered by web components without walking every shadow tree.
    const target = event.composedPath()[0] ?? event.target;
    if (target instanceof HTMLElement) this.maybeAttach(target);
  };

  /**
   * Destroys controllers whose field has left the DOM. `element.isConnected`
   * catches removals the light-DOM MutationObserver and `Node.contains()` miss —
   * notably fields inside shadow roots (removed from the shadow tree, or whose
   * host was detached). Returns whether anything was pruned.
   */
  private pruneDisconnected(): boolean {
    let pruned = false;
    for (const [element, controller] of [...this.controllers]) {
      if (!element.isConnected) {
        controller.destroy();
        this.controllers.delete(element);
        pruned = true;
      }
    }
    return pruned;
  }

  private onMutations(mutations: MutationRecord[]): void {
    const before = this.controllers.size;
    let sawRemoval = false;
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
      if (mutation.removedNodes.length > 0) sawRemoval = true;
      for (const node of mutation.removedNodes) {
        if (node instanceof HTMLElement) this.cleanupRemoved(node);
      }
    }
    // A removed shadow host fires the observer but `host.contains(shadowField)`
    // is false, so also prune any controller whose field is now disconnected.
    if (sawRemoval) this.pruneDisconnected();
    // If that emptied the controller set, stop observing until a field is focused.
    if (this.controllers.size !== before) this.syncObserver();
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
    this.controllers.set(
      element,
      new FieldController(adapter, this.settings, this.tooltip, this.origin),
    );
    this.syncObserver();
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
    void sendToBackground({ type: 'warmup', target: 'background' }).catch((error: unknown) => {
      if (isContextInvalidationError(error)) invalidateContext();
    });
  }
}
