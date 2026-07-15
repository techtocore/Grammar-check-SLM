import type { Correction } from '../core/types';

export interface TooltipCallbacks {
  onAccept(correction: Correction): void;
  onIgnore(correction: Correction): void;
}

const LABELS: Record<Correction['kind'], string> = {
  replace: 'Suggestion',
  insert: 'Missing word',
  delete: 'Remove',
};

const ACCEPT_LABELS: Record<Correction['kind'], string> = {
  replace: 'Replace',
  insert: 'Insert',
  delete: 'Remove',
};

/** Floating suggestion card shown when hovering a highlighted correction. */
export class Tooltip {
  private readonly root: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly acceptBtn: HTMLButtonElement;
  private readonly ignoreBtn: HTMLButtonElement;
  private hideTimer: number | null = null;
  private current: Correction | null = null;
  private callbacks: TooltipCallbacks | null = null;

  // Hides the tooltip when the user taps/clicks anywhere outside it — the only
  // dismissal path on touch, where there is no pointer-leave.
  private readonly onOutsidePointerDown = (event: Event): void => {
    if (!this.root.contains(event.target as Node | null)) this.hide();
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.hide();
  };

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'gcslm-tooltip';
    this.root.style.display = 'none';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Grammar suggestion');

    this.label = document.createElement('div');
    this.label.className = 'gcslm-tooltip-label';

    this.body = document.createElement('div');
    this.body.className = 'gcslm-tooltip-body';

    const actions = document.createElement('div');
    actions.className = 'gcslm-tooltip-actions';

    this.acceptBtn = document.createElement('button');
    this.acceptBtn.type = 'button';
    this.acceptBtn.className = 'gcslm-btn gcslm-btn-accept';

    this.ignoreBtn = document.createElement('button');
    this.ignoreBtn.type = 'button';
    this.ignoreBtn.className = 'gcslm-btn gcslm-btn-ignore';
    this.ignoreBtn.textContent = 'Dismiss';

    actions.append(this.acceptBtn, this.ignoreBtn);
    this.root.append(this.label, this.body, actions);
    document.body.appendChild(this.root);

    this.acceptBtn.addEventListener('click', () => {
      if (this.current && this.callbacks) this.callbacks.onAccept(this.current);
      this.hide();
    });
    this.ignoreBtn.addEventListener('click', () => {
      if (this.current && this.callbacks) this.callbacks.onIgnore(this.current);
      this.hide();
    });
    this.root.addEventListener('mouseenter', () => this.cancelHide());
    this.root.addEventListener('mouseleave', () => this.scheduleHide());
  }

  contains(node: EventTarget | null): boolean {
    return node instanceof Node && this.root.contains(node);
  }

  isShowing(correction: Correction): boolean {
    return this.root.style.display !== 'none' && this.current === correction;
  }

  show(rect: DOMRect, correction: Correction, callbacks: TooltipCallbacks): void {
    this.cancelHide();
    this.current = correction;
    this.callbacks = callbacks;

    this.label.textContent = LABELS[correction.kind];
    this.acceptBtn.textContent = ACCEPT_LABELS[correction.kind];
    this.renderBody(correction);

    // Make measurable, then position.
    this.root.style.visibility = 'hidden';
    this.root.style.display = 'block';
    this.root.style.left = '0px';
    this.root.style.top = '0px';

    const size = this.root.getBoundingClientRect();
    const margin = 8;
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const maxLeft = viewportLeft + viewportWidth - size.width - margin;
    let left = Math.min(Math.max(viewportLeft + margin, rect.left), maxLeft);
    if (!Number.isFinite(left) || left < viewportLeft + margin) left = viewportLeft + margin;
    let top = rect.top - size.height - margin;
    if (top < viewportTop + margin) top = rect.bottom + margin;
    const maxTop = viewportTop + viewportHeight - size.height - margin;
    top = Math.min(Math.max(viewportTop + margin, top), Math.max(viewportTop + margin, maxTop));

    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
    this.root.style.visibility = 'visible';
    // addEventListener de-dupes identical registrations, so this is safe to call
    // on every show; hide() removes it.
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
  }

  scheduleHide(delay = 220): void {
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => this.hide(), delay);
  }

  cancelHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  hide(): void {
    this.cancelHide();
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    this.root.style.display = 'none';
    this.current = null;
    this.callbacks = null;
  }

  destroy(): void {
    this.cancelHide();
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    this.root.remove();
  }

  private renderBody(correction: Correction): void {
    this.body.replaceChildren();
    if (correction.kind === 'insert') {
      const ins = document.createElement('span');
      ins.className = 'gcslm-ins';
      ins.textContent = correction.suggestion.trim();
      this.body.append(ins);
      return;
    }
    if (correction.kind === 'delete') {
      const del = document.createElement('span');
      del.className = 'gcslm-del';
      del.textContent = correction.original.trim();
      this.body.append(del);
      return;
    }
    const del = document.createElement('span');
    del.className = 'gcslm-del';
    del.textContent = correction.original;
    const arrow = document.createElement('span');
    arrow.className = 'gcslm-arrow';
    arrow.textContent = '→';
    const ins = document.createElement('span');
    ins.className = 'gcslm-ins';
    ins.textContent = correction.suggestion;
    this.body.append(del, arrow, ins);
  }
}
