import type { Settings } from '../../shared/settings';
import type { FieldKind } from './types';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);
const CONTENTEDITABLE_VALUES = new Set(['', 'true', 'plaintext-only']);

export function isTextInput(
  element: HTMLElement,
): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type))
  );
}

export function isEditableTextInput(
  element: HTMLElement,
): element is HTMLInputElement | HTMLTextAreaElement {
  return isTextInput(element) && !element.readOnly && !element.disabled;
}

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
  return isEditableTextInput(element) ? 'textinput' : null;
}
