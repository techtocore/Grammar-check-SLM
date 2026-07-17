import type { Correction } from '../core/types';
import type { DevicePreference } from './models';
import type { Backend, Settings } from './settings';

export type ModelState = 'idle' | 'loading' | 'ready' | 'error' | 'disabled';

export interface ModelStatus {
  state: ModelState;
  /** 0..100 while loading. */
  progress: number;
  modelId: string;
  device: 'webgpu' | 'wasm' | 'built-in' | 'unknown';
  message?: string;
  error?: string;
}

/**
 * Preferences handed to the offscreen model runner. The runner itself detects
 * WebGPU / built-in-AI support and resolves these into a concrete backend.
 */
export interface RunnerConfig {
  /** Backend preference. */
  backend: Backend;
  /** Preset id, or `'auto'` (Transformers.js only). */
  model: string;
  device: DevicePreference;
  language: string;
}

export interface CheckResult {
  requestId: string;
  /** Echo of the exact text that was checked, so callers can detect staleness. */
  sourceText: string;
  corrections: Correction[];
  error?: string;
}

export interface ModelInfo {
  id: string;
  modelId: string;
  label: string;
  description: string;
  approxDownloadMB: number;
  requiresWebGPU: boolean;
  cached: boolean;
  partial: boolean;
  active: boolean;
  download?: ModelDownloadStatus;
}

export interface ModelDownloadStatus {
  modelId: string;
  state: 'downloading' | 'error';
  progress: number;
  error?: string;
}

// ---- Messages addressed to the background service worker ----

export type BackgroundMessage =
  | { type: 'status'; target: 'background' }
  | { type: 'warmup'; target: 'background' }
  | { type: 'retry'; target: 'background' }
  | { type: 'check'; target: 'background'; requestId: string; text: string }
  | { type: 'correct'; target: 'background'; requestId: string; text: string }
  | { type: 'settings:get'; target: 'background' }
  | { type: 'settings:set'; target: 'background'; patch: Partial<Settings> }
  | { type: 'setup:verify'; target: 'background' }
  | { type: 'setup:complete'; target: 'background' }
  | { type: 'site:enabled'; target: 'background'; origin: string }
  | { type: 'models:list'; target: 'background' }
  | {
      type: 'models:download';
      target: 'background';
      modelId: string;
      purpose?: 'onboarding';
    }
  | {
      type: 'models:onboarding:select';
      target: 'background';
      modelId: string;
      cached: boolean;
    }
  | { type: 'models:delete'; target: 'background'; modelId: string };

// ---- Messages addressed to the offscreen document ----

export type OffscreenMessage =
  | { type: 'status'; target: 'offscreen' }
  | { type: 'warmup'; target: 'offscreen' }
  | { type: 'reload'; target: 'offscreen' }
  | { type: 'suspend'; target: 'offscreen' }
  | { type: 'device:detect'; target: 'offscreen' }
  | { type: 'downloads:status'; target: 'offscreen' }
  | {
      type: 'onboarding:select';
      target: 'offscreen';
      modelId: string;
      device: DevicePreference;
    }
  | { type: 'download:delete'; target: 'offscreen'; modelId: string }
  | { type: 'check'; target: 'offscreen'; requestId: string; text: string }
  | { type: 'config'; target: 'offscreen'; config: RunnerConfig }
  | {
      type: 'download';
      target: 'offscreen';
      modelId: string;
      device: DevicePreference;
      purpose?: 'onboarding';
    };

// ---- Messages addressed to a page's content script (via chrome.tabs.sendMessage) ----

export type ContentMessage =
  | { type: 'gc-ready-probe'; target: 'content' }
  | { type: 'gc-correcting'; target: 'content'; requestId: string; original: string }
  | {
      type: 'gc-correct-result';
      target: 'content';
      requestId: string;
      corrected: string;
      original: string;
      error?: string;
    };

// ---- Broadcasts (no response expected) ----

export interface StatusBroadcast {
  type: 'status:changed';
  target: 'ui';
  status: ModelStatus;
}

export interface DownloadProgress {
  type: 'download:progress';
  target: 'ui';
  modelId: string;
  state: 'downloading' | 'done' | 'error' | 'cancelled';
  progress: number;
  error?: string;
}

type SenderContext = 'content' | 'popup' | 'options' | 'offscreen' | 'background' | 'unknown';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function senderContext(sender: chrome.runtime.MessageSender, extensionId: string): SenderContext {
  if (sender.id !== extensionId) return 'unknown';

  if (sender.url) {
    try {
      const url = new URL(sender.url);
      if (url.protocol === 'chrome-extension:') {
        if (url.host !== extensionId) return 'unknown';
        if (url.pathname === '/popup.html') return 'popup';
        if (url.pathname === '/options.html') return 'options';
        if (url.pathname === '/offscreen.html') return 'offscreen';
        if (url.pathname === '/background.js') return 'background';
        return 'unknown';
      }
    } catch {
      return 'unknown';
    }
  }

  if (sender.tab) return 'content';
  // Service-worker messages can omit a document URL depending on Chromium.
  return sender.url ? 'unknown' : 'background';
}

export function isBackgroundMessage(msg: unknown): msg is BackgroundMessage {
  if (!isRecord(msg) || msg.target !== 'background' || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'status':
    case 'warmup':
    case 'retry':
    case 'settings:get':
    case 'setup:verify':
    case 'setup:complete':
      return true;
    case 'models:list':
      return msg.device === undefined;
    case 'check':
    case 'correct':
      return hasText(msg.requestId) && typeof msg.text === 'string';
    case 'settings:set':
      return isRecord(msg.patch);
    case 'site:enabled':
      return hasText(msg.origin);
    case 'models:download':
      return hasText(msg.modelId) && (msg.purpose === undefined || msg.purpose === 'onboarding');
    case 'models:onboarding:select':
      return hasText(msg.modelId) && typeof msg.cached === 'boolean';
    case 'models:delete':
      return hasText(msg.modelId);
    default:
      return false;
  }
}

export function isOffscreenMessage(msg: unknown): msg is OffscreenMessage {
  if (!isRecord(msg) || msg.target !== 'offscreen' || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'status':
    case 'warmup':
    case 'reload':
    case 'suspend':
    case 'device:detect':
    case 'downloads:status':
      return true;
    case 'check':
      return hasText(msg.requestId) && typeof msg.text === 'string';
    case 'config':
      return isRecord(msg.config);
    case 'download':
      return (
        hasText(msg.modelId) &&
        typeof msg.device === 'string' &&
        ['auto', 'webgpu', 'wasm'].includes(msg.device) &&
        (msg.purpose === undefined || msg.purpose === 'onboarding')
      );
    case 'onboarding:select':
      return (
        hasText(msg.modelId) &&
        typeof msg.device === 'string' &&
        ['auto', 'webgpu', 'wasm'].includes(msg.device)
      );
    case 'download:delete':
      return hasText(msg.modelId);
    default:
      return false;
  }
}

export function isStatusBroadcast(msg: unknown): msg is StatusBroadcast {
  return (
    typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'status:changed'
  );
}

export function isDownloadProgress(msg: unknown): msg is DownloadProgress {
  if (
    !isRecord(msg) ||
    msg.type !== 'download:progress' ||
    msg.target !== 'ui' ||
    !hasText(msg.modelId) ||
    !['downloading', 'done', 'error', 'cancelled'].includes(String(msg.state)) ||
    typeof msg.progress !== 'number' ||
    !Number.isFinite(msg.progress) ||
    msg.progress < 0 ||
    msg.progress > 100
  ) {
    return false;
  }
  return msg.error === undefined || typeof msg.error === 'string';
}

export function isContentMessage(msg: unknown): msg is ContentMessage {
  if (!isRecord(msg) || msg.target !== 'content' || typeof msg.type !== 'string') return false;
  if (msg.type === 'gc-ready-probe') return true;
  if (msg.type === 'gc-correcting') {
    return hasText(msg.requestId) && typeof msg.original === 'string';
  }
  return (
    msg.type === 'gc-correct-result' &&
    hasText(msg.requestId) &&
    typeof msg.corrected === 'string' &&
    typeof msg.original === 'string' &&
    (msg.error === undefined || typeof msg.error === 'string')
  );
}

/** Whether this sender is allowed to invoke the requested background operation. */
export function isAuthorizedBackgroundMessage(
  message: BackgroundMessage,
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): boolean {
  const context = senderContext(sender, extensionId);
  if (context === 'content') return message.type === 'check' || message.type === 'warmup';
  if (context === 'popup') {
    return ![
      'check',
      'models:list',
      'models:download',
      'models:delete',
      'setup:verify',
      'setup:complete',
    ].includes(message.type);
  }
  if (context === 'options') {
    return !['check', 'correct', 'site:enabled', 'warmup'].includes(message.type);
  }
  return false;
}

/** Whether a runtime message originated in this extension's service worker. */
export function isBackgroundSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): boolean {
  return senderContext(sender, extensionId) === 'background';
}

/** Whether a status/progress broadcast originated in the offscreen runner. */
export function isOffscreenSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): boolean {
  return senderContext(sender, extensionId) === 'offscreen';
}

/** Sends a typed message to the background worker and awaits its response. */
export function sendToBackground<R>(msg: BackgroundMessage): Promise<R> {
  return chrome.runtime.sendMessage<BackgroundMessage, R>(msg);
}

/** Sends a typed message to the offscreen document and awaits its response. */
export function sendToOffscreen<R>(msg: OffscreenMessage): Promise<R> {
  return chrome.runtime.sendMessage<OffscreenMessage, R>(msg);
}

/** Broadcasts a model-status change to any listening UI (popup). Errors ignored. */
export function broadcastStatus(status: ModelStatus): void {
  const message: StatusBroadcast = { type: 'status:changed', target: 'ui', status };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** Broadcasts per-model download progress to any listening UI (options page). */
export function broadcastDownload(progress: Omit<DownloadProgress, 'type' | 'target'>): void {
  const message: DownloadProgress = { type: 'download:progress', target: 'ui', ...progress };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** Generates a unique request id. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
