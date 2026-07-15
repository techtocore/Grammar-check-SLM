// Highlight rendering. Prefers the CSS Custom Highlight API (Chrome 105+), which
// underlines ranges WITHOUT mutating the DOM — no wrapper spans, no caret jumps.
// Falls back to an absolutely-positioned overlay for inputs/textareas and for
// contexts where the Highlight API is unavailable.

const HIGHLIGHT_NAME = 'grammar-slm';

interface HighlightLike {
  type?: 'highlight' | 'spelling-error' | 'grammar-error';
  add(range: Range): void;
  delete(range: Range): boolean;
  clear(): void;
}
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}

function highlightApi(): { registry: HighlightRegistryLike; create: () => HighlightLike } | null {
  const globals = globalThis as unknown as {
    Highlight?: new () => HighlightLike;
    CSS?: { highlights?: HighlightRegistryLike };
  };
  if (typeof globals.Highlight !== 'function' || !globals.CSS?.highlights) return null;
  const Ctor = globals.Highlight;
  const registry = globals.CSS.highlights;
  return { registry, create: () => new Ctor() };
}

let sharedHighlight: HighlightLike | null = null;
let pageStyleInjected = false;

// `::highlight()` rules only take effect from the page's own CSSOM, not from
// content-script (isolated-world) stylesheets. So inject the rule into the page.
function ensurePageHighlightStyle(): void {
  if (pageStyleInjected) return;
  pageStyleInjected = true;
  const style = document.createElement('style');
  style.id = 'gcslm-highlight-style';
  style.textContent =
    `::highlight(${HIGHLIGHT_NAME}){` +
    'text-decoration-line:underline;' +
    'text-decoration-color:#ef4444;' +
    'text-decoration-style:wavy;' +
    'text-decoration-skip-ink:none;}';
  (document.head ?? document.documentElement).appendChild(style);
}

function getSharedHighlight(): HighlightLike | null {
  const api = highlightApi();
  if (!api) return null;
  if (!sharedHighlight) {
    ensurePageHighlightStyle();
    sharedHighlight = api.create();
    try {
      sharedHighlight.type = 'grammar-error';
    } catch {
      /* Older Highlight implementations expose no writable type. */
    }
    api.registry.set(HIGHLIGHT_NAME, sharedHighlight);
  }
  return sharedHighlight;
}

export function supportsHighlightApi(): boolean {
  return highlightApi() !== null;
}

/** Tracks a single field's ranges within the shared Highlight registry. */
export class HighlightSet {
  private ranges: Range[] = [];

  set(ranges: Range[]): void {
    const highlight = getSharedHighlight();
    if (!highlight) return;
    for (const range of this.ranges) highlight.delete(range);
    this.ranges = ranges;
    for (const range of this.ranges) highlight.add(range);
  }

  clear(): void {
    const highlight = getSharedHighlight();
    for (const range of this.ranges) highlight?.delete(range);
    this.ranges = [];
  }
}

/** A fixed-position layer that draws underline marks from viewport rects. */
export class Overlay {
  private readonly layer: HTMLDivElement;
  // Marks are pooled and reused: repositioning only updates styles, never the
  // DOM tree, which avoids GC churn and stops us from triggering the page's
  // MutationObserver (and our own) on every scroll frame.
  private readonly marks: HTMLDivElement[] = [];

  constructor() {
    this.layer = document.createElement('div');
    this.layer.className = 'gcslm-overlay';
    this.layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.layer);
  }

  setRects(rects: DOMRect[]): void {
    while (this.marks.length < rects.length) {
      const mark = document.createElement('div');
      mark.className = 'gcslm-underline';
      mark.style.display = 'none';
      this.layer.appendChild(mark);
      this.marks.push(mark);
    }
    for (let i = 0; i < this.marks.length; i++) {
      const mark = this.marks[i]!;
      const rect = rects[i];
      if (rect) {
        mark.style.left = `${rect.left}px`;
        mark.style.top = `${rect.bottom - 2}px`;
        mark.style.width = `${Math.max(rect.width, 4)}px`;
        mark.style.display = '';
      } else if (mark.style.display !== 'none') {
        mark.style.display = 'none';
      }
    }
  }

  clear(): void {
    for (const mark of this.marks) {
      if (mark.style.display !== 'none') mark.style.display = 'none';
    }
  }

  destroy(): void {
    this.layer.remove();
    this.marks.length = 0;
  }
}
