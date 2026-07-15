import { describe, expect, it } from 'vitest';
import {
  isAuthorizedBackgroundMessage,
  isBackgroundMessage,
  isBackgroundSender,
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

  it('limits content scripts to checks and warmup', () => {
    const content = sender('https://example.com/editor', true);
    expect(isAuthorizedBackgroundMessage(check, content, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(settings, content, EXTENSION_ID)).toBe(false);
    expect(isAuthorizedBackgroundMessage(deleteModel, content, EXTENSION_ID)).toBe(false);
  });

  it('allows only the intended extension UI operations', () => {
    const popup = sender(`chrome-extension://${EXTENSION_ID}/popup.html`);
    const options = sender(`chrome-extension://${EXTENSION_ID}/options.html`, true);
    expect(isAuthorizedBackgroundMessage(settings, popup, EXTENSION_ID)).toBe(true);
    expect(isAuthorizedBackgroundMessage(check, popup, EXTENSION_ID)).toBe(false);
    expect(isAuthorizedBackgroundMessage(deleteModel, options, EXTENSION_ID)).toBe(true);
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
