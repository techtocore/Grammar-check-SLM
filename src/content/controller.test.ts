import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Correction } from '../core/types';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { FieldAdapter, FieldHandlers } from './fields/types';
import type { Tooltip, TooltipCallbacks } from './tooltip';
import { FieldController } from './controller';

describe('FieldController', () => {
  afterEach(() => vi.useRealTimers());

  it('does not apply a displayed suggestion after a field becomes sensitive', () => {
    vi.useFakeTimers();
    const field = document.createElement('input');
    field.type = 'text';
    field.value = 'I has a cat.';
    document.body.append(field);

    const correction: Correction = {
      start: 2,
      end: 5,
      original: 'has',
      suggestion: 'have',
      kind: 'replace',
    };
    let handlers: FieldHandlers | undefined;
    const applyEdit = vi.fn(() => true);
    const adapter: FieldAdapter = {
      element: field,
      kind: 'textinput',
      getText: () => field.value,
      showCorrections: vi.fn(),
      clear: vi.fn(),
      rectFor: vi.fn(() => null),
      correctionRects: () => [{ correction, rect: new DOMRect(0, 0, 20, 10) }],
      applyEdit,
      attach: (next) => {
        handlers = next;
      },
      destroy: vi.fn(),
    };

    let callbacks: TooltipCallbacks | undefined;
    const tooltip = {
      hide: vi.fn(),
      cancelHide: vi.fn(),
      scheduleHide: vi.fn(),
      contains: vi.fn(() => false),
      isShowing: vi.fn(() => false),
      show: vi.fn((_rect: DOMRect, _correction: Correction, next: TooltipCallbacks) => {
        callbacks = next;
      }),
    } as unknown as Tooltip;

    const controller = new FieldController(adapter, DEFAULT_SETTINGS, tooltip);
    expect(handlers).toBeDefined();
    field.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));
    vi.runOnlyPendingTimers();
    expect(callbacks).toBeDefined();

    field.type = 'password';
    callbacks?.onAccept(correction);
    expect(applyEdit).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('cancels pending checks when settings change instead of loading a model', () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage } });
    const field = document.createElement('textarea');
    field.value = 'This sentence has enough words.';
    document.body.append(field);
    const adapter: FieldAdapter = {
      element: field,
      kind: 'textinput',
      getText: () => field.value,
      showCorrections: vi.fn(),
      clear: vi.fn(),
      rectFor: vi.fn(() => null),
      correctionRects: () => [],
      applyEdit: vi.fn(() => true),
      attach: vi.fn(),
      destroy: vi.fn(),
    };
    const tooltip = {
      hide: vi.fn(),
    } as unknown as Tooltip;
    const controller = new FieldController(adapter, DEFAULT_SETTINGS, tooltip);
    expect(vi.getTimerCount()).toBe(1);

    controller.updateSettings({ ...DEFAULT_SETTINGS, model: 'qwen3.5-0.8b' });
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(sendMessage).not.toHaveBeenCalled();
    controller.destroy();
  });
});
