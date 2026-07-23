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
    vi.advanceTimersByTime(20);
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

  it('checks subsequent bounded passes and merges their corrections', async () => {
    vi.useFakeTimers();
    const field = document.createElement('textarea');
    field.value = 'This sentence has enough words for another sentence.';
    document.body.append(field);
    const firstCorrection: Correction = {
      start: 5,
      end: 13,
      original: 'sentence',
      suggestion: 'statement',
      kind: 'replace',
    };
    const secondCorrection: Correction = {
      start: 36,
      end: 44,
      original: 'sentence',
      suggestion: 'statement',
      kind: 'replace',
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        requestId: 'first',
        sourceText: field.value,
        corrections: [firstCorrection],
        nextOffset: 30,
        complete: false,
      })
      .mockResolvedValueOnce({
        requestId: 'second',
        sourceText: field.value,
        corrections: [secondCorrection],
        nextOffset: field.value.length,
        complete: true,
      });
    vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage } });
    const showCorrections = vi.fn();
    const adapter: FieldAdapter = {
      element: field,
      kind: 'textinput',
      getText: () => field.value,
      showCorrections,
      clear: vi.fn(),
      rectFor: vi.fn(() => null),
      correctionRects: () => [],
      applyEdit: vi.fn(() => true),
      attach: vi.fn(),
      destroy: vi.fn(),
    };
    const tooltip = { hide: vi.fn() } as unknown as Tooltip;
    const controller = new FieldController(adapter, DEFAULT_SETTINGS, tooltip);

    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ startOffset: 0 });
    expect(sendMessage.mock.calls[1]?.[0]).toMatchObject({ startOffset: 30 });
    expect(showCorrections).toHaveBeenLastCalledWith([firstCorrection, secondCorrection]);
    controller.destroy();
  });

  it('restarts a multi-pass check instead of mixing runner configurations', async () => {
    vi.useFakeTimers();
    const field = document.createElement('textarea');
    field.value = 'This sentence has enough words for another sentence.';
    document.body.append(field);
    const oldCorrection: Correction = {
      start: 5,
      end: 13,
      original: 'sentence',
      suggestion: 'statement',
      kind: 'replace',
    };
    const newCorrection: Correction = {
      start: 36,
      end: 44,
      original: 'sentence',
      suggestion: 'statement',
      kind: 'replace',
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        requestId: 'old',
        sourceText: field.value,
        corrections: [oldCorrection],
        nextOffset: 30,
        complete: false,
        configKey: 'old-config',
      })
      .mockResolvedValueOnce({
        requestId: 'changed',
        sourceText: field.value,
        corrections: [],
        nextOffset: 0,
        complete: true,
        configKey: 'new-config',
        configurationChanged: true,
      })
      .mockResolvedValueOnce({
        requestId: 'new',
        sourceText: field.value,
        corrections: [newCorrection],
        nextOffset: field.value.length,
        complete: true,
        configKey: 'new-config',
      });
    vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage } });
    const showCorrections = vi.fn();
    const adapter: FieldAdapter = {
      element: field,
      kind: 'textinput',
      getText: () => field.value,
      showCorrections,
      clear: vi.fn(),
      rectFor: vi.fn(() => null),
      correctionRects: () => [],
      applyEdit: vi.fn(() => true),
      attach: vi.fn(),
      destroy: vi.fn(),
    };
    const tooltip = { hide: vi.fn() } as unknown as Tooltip;
    const controller = new FieldController(adapter, DEFAULT_SETTINGS, tooltip);

    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));

    expect(sendMessage.mock.calls[1]?.[0]).toMatchObject({
      startOffset: 30,
      configKey: 'old-config',
    });
    expect(sendMessage.mock.calls[2]?.[0]).toMatchObject({
      startOffset: 0,
      configKey: 'new-config',
    });
    expect(showCorrections).toHaveBeenLastCalledWith([newCorrection]);
    controller.destroy();
  });
});
