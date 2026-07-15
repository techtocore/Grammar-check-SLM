import type { Settings } from '../../shared/settings';
import type { FieldKind } from './types';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);
const CONTENTEDITABLE_VALUES = new Set(['', 'true', 'plaintext-only']);

/** Returns the adapter kind an element is currently safe and eligible to use. */
export function fieldKindFor(element: HTMLElement, settings: Settings): FieldKind | null {
  if (settings.checkContentEditable) {
    const editable = element.getAttribute('contenteditable')?.trim().toLowerCase();
    if (
      editable !== undefined &&
      CONTENTEDITABLE_VALUES.has(editable) &&
      element.isContentEditable
    ) {
      return 'contenteditable';
    }
  }
  if (!settings.checkTextInputs) return null;
  if (element instanceof HTMLTextAreaElement) {
    return !element.readOnly && !element.disabled ? 'textinput' : null;
  }
  if (
    element instanceof HTMLInputElement &&
    TEXT_INPUT_TYPES.has(element.type) &&
    !element.readOnly &&
    !element.disabled
  ) {
    return 'textinput';
  }
  return null;
}
