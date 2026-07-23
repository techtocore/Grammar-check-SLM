import { describe, expect, it } from 'vitest';
import {
  isAuthorizedBackgroundMessage,
  isBackgroundMessage,
  isBackgroundSender,
  isContentMessage,
  isDownloadProgress,
  isOffscreenMessage,
  isOffscreenSender,
  type BackgroundMessage,
} from './messages';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

function sender(url?: string, tab = false): chrome.runtime.MessageSender {
  return {
    id: EXTENSION_ID,
    ...(url ? { url } : {}),
    ...(tab ? { tab: { id: 1 } as chrome.tabs.Tab } : {}),
  };
}

describe('runtime message validation', () => {
  it('rejects target-only and malformed messages', () => {
    expect(isBackgroundMessage({ target: 'background' })).toBe(false);
    expect(
      isBackgroundMessage({ target: 'background', type: 'check', requestId: 4, text: '' }),
    ).toBe(false);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'check',
        requestId: 'request',
        text: 'Text',
        startOffset: -1,
      }),
    ).toBe(false);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'correct',
        requestId: 'request',
        text: 'Text',
        configKey: 4,
      }),
    ).toBe(false);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'editor:draft:save',
        sourceId: 'popup',
        sequence: 1,
        revision: 1,
        draft: { text: 'Text', corrections: 'invalid' },
      }),
    ).toBe(false);
    expect(
      isOffscreenMessage({ target: 'offscreen', type: 'download', modelId: '', device: 'wasm' }),
    ).toBe(false);
    expect(
      isOffscreenMessage({
        target: 'offscreen',
        type: 'download',
        modelId: 'model',
        device: 'cuda',
      }),
    ).toBe(false);
    expect(
      isDownloadProgress({
        type: 'download:progress',
        target: 'ui',
        modelId: 'model',
        state: 'downloading',
        progress: 101,
      }),
    ).toBe(false);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'models:list',
        device: 'cuda',
      }),
    ).toBe(false);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'models:download',
        modelId: 'model',
        purpose: 'prefetch',
      }),
    ).toBe(false);
  });

  it('accepts a complete discriminated message', () => {
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'check',
        requestId: 'request-1',
        text: '',
      }),
    ).toBe(true);
    expect(isContentMessage({ target: 'content', type: 'gc-ready-probe' })).toBe(true);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'suspend' })).toBe(true);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'device:detect' })).toBe(true);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'downloads:status' })).toBe(true);
    expect(
      isOffscreenMessage({
        target: 'offscreen',
        type: 'download:delete',
        modelId: 'model',
      }),
    ).toBe(true);
    expect(
      isOffscreenMessage({
        target: 'offscreen',
        type: 'onboarding:select',
        modelId: 'model',
        device: 'auto',
      }),
    ).toBe(true);
    expect(
      isDownloadProgress({
        type: 'download:progress',
        target: 'ui',
        modelId: 'model',
        state: 'downloading',
        progress: 42,
      }),
    ).toBe(true);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'models:onboarding:select',
        modelId: 'model',
        cached: true,
      }),
    ).toBe(true);
    expect(
      isDownloadProgress({
        type: 'download:progress',
        target: 'ui',
        modelId: 'model',
        state: 'cancelled',
        progress: 0,
      }),
    ).toBe(true);
  });
});

describe('runtime sender authorization', () => {
  const check: BackgroundMessage = {
    type: 'check',
    target: 'background',
    requestId: 'request-1',
    text: 'Text',
  };
  const settings: BackgroundMessage = {
    type: 'settings:set',
    target: 'background',
    patch: { enabled: false },
  };
  const deleteModel: BackgroundMessage = {
    type: 'models:delete',
    target: 'background',
    modelId: 'onnx-community/Qwen3-0.6B-ONNX',
  };
  const saveDraft: BackgroundMessage = {
    type: 'editor:draft:save',
    target: 'background',
    sourceId: 'popup-a',
    sequence: 1,
    revision: 100,
    draft: { text: 'Keep this text.' },
  };
  const takePending: BackgroundMessage = {
    type: 'pending:take',
    target: 'background',
  };
  const saveDraftResult: BackgroundMessage = {
    type: 'editor:draft:result',
    target: 'background',
    baseRevision: 100,
    text: 'Keep this text.',
    corrections: [],
    configKey: 'runner-a',
  };

  it('limits content scripts to checks and warmup', () => {
    const content = sender('https://example.com/editor', true);
    expect(isAuthorizedBackgroundMessage(check, content, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(settings, content, EXTENSION_ID)).toBe(false);
    expect(isAuthorizedBackgroundMessage(deleteModel, content, EXTENSION_ID)).toBe(false);
  });

  it('allows only the intended extension UI operations', () => {
    const popup = sender(`chrome-extension://${EXTENSION_ID}/popup.html`);
    const expanded = sender(
      `chrome-extension://${EXTENSION_ID}/popup.html?view=expanded&origin=https%3A%2F%2Fexample.com`,
      true,
    );
    const options = sender(`chrome-extension://${EXTENSION_ID}/options.html`, true);
    expect(isAuthorizedBackgroundMessage(settings, popup, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(settings, expanded, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(saveDraft, popup, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(saveDraftResult, popup, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(takePending, popup, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(check, popup, EXTENSION_ID)).toBe(false);
    expect(isAuthorizedBackgroundMessage(deleteModel, options, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(saveDraft, options, EXTENSION_ID)).toBe(false);
    expect(isAuthorizedBackgroundMessage(saveDraftResult, options, EXTENSION_ID)).toBe(false);
    expect(isAuthorizedBackgroundMessage(takePending, options, EXTENSION_ID)).toBe(false);
    expect(isAuthorizedBackgroundMessage(check, options, EXTENSION_ID)).toBe(false);
  });

  it('rejects foreign and unknown extension pages', () => {
    const foreign = { id: 'foreign', tab: { id: 1 } as chrome.tabs.Tab };
    const unknown = sender(`chrome-extension://${EXTENSION_ID}/unexpected.html`);
    expect(isAuthorizedBackgroundMessage(check, foreign, EXTENSION_ID)).toBe(false);
    expect(isAuthorizedBackgroundMessage(settings, unknown, EXTENSION_ID)).toBe(false);
  });

  it('distinguishes the background worker and offscreen document', () => {
    expect(isBackgroundSender(sender(), EXTENSION_ID)).toBe(true);
    expect(
      isBackgroundSender(sender(`chrome-extension://${EXTENSION_ID}/background.js`), EXTENSION_ID),
    ).toBe(true);
    expect(
      isOffscreenSender(sender(`chrome-extension://${EXTENSION_ID}/offscreen.html`), EXTENSION_ID),
    ).toBe(true);
    expect(
      isOffscreenSender(sender(`chrome-extension://${EXTENSION_ID}/popup.html`), EXTENSION_ID),
    ).toBe(false);
  });
});
