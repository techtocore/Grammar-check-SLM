/** Whether this document can host the extension's HTML-based content UI. */
export function supportsContentUi(document: Document): boolean {
  return document.documentElement instanceof HTMLElement && document.body !== null;
}
