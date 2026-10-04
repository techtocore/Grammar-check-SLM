import { isEditableTextInput } from './eligibility';

type TextField = HTMLInputElement | HTMLTextAreaElement;

function setNativeValue(field: TextField, value: string): void {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  /* eslint-disable @typescript-eslint/unbound-method -- setters are invoked immediately via .call */
  const prototypeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const instanceSetter = Object.getOwnPropertyDescriptor(field, 'value')?.set;
  /* eslint-enable @typescript-eslint/unbound-method */
  if (prototypeSetter && prototypeSetter !== instanceSetter) {
    prototypeSetter.call(field, value);
  } else {
    field.value = value;
  }
}

export function replaceTextInputRange(
  field: TextField,
  start: number,
  end: number,
  expectedOriginal: string,
  suggestion: string,
  selectReplacement = false,
): boolean {
  if (!field.isConnected || !isEditableTextInput(field)) return false;
  const value = field.value;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > value.length ||
    start > end ||
    value.slice(start, end) !== expectedOriginal
  ) {
    return false;
  }

  const before = new InputEvent('beforeinput', {
    bubbles: true,
    composed: true,
    cancelable: true,
    inputType: 'insertReplacementText',
    data: suggestion,
  });
  if (!field.dispatchEvent(before)) return false;
  // Page handlers run synchronously and may replace the value or lock the field.
  if (!field.isConnected || !isEditableTextInput(field) || field.value !== value) return false;

  const selectionStart = field.selectionStart;
  const selectionEnd = field.selectionEnd;
  const selectionDirection = field.selectionDirection;
  setNativeValue(field, value.slice(0, start) + suggestion + value.slice(end));
  if (selectionStart !== null && selectionEnd !== null) {
    const delta = suggestion.length - (end - start);
    const adjust = (position: number): number => {
      if (position < start) return position;
      if (position >= end) return position + delta;
      if (position === start) return start;
      return start + suggestion.length;
    };
    field.setSelectionRange(
      selectReplacement ? start : adjust(selectionStart),
      selectReplacement ? start + suggestion.length : adjust(selectionEnd),
      selectReplacement ? undefined : (selectionDirection ?? undefined),
    );
  }
  field.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertReplacementText',
      data: suggestion,
    }),
  );
  return true;
}
