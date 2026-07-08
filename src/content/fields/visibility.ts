// Whether a field is actually rendered right now. Uses Element.checkVisibility()
// (Chrome 105+, always available at our minimum of 116) so display:none,
// visibility:hidden, opacity:0, and content-visibility all count as hidden — we
// must not draw stray underline marks for a field the user can't see.

type CheckVisibilityOptions = {
  contentVisibilityAuto?: boolean;
  opacityProperty?: boolean;
  visibilityProperty?: boolean;
};

export function isElementVisible(element: Element): boolean {
  const el = element as Element & {
    checkVisibility?: (options?: CheckVisibilityOptions) => boolean;
  };
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true,
    });
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}
