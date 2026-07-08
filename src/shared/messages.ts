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
  active: boolean;
}

// ---- Messages addressed to the background service worker ----

export type BackgroundMessage =
  | { type: 'status'; target: 'background' }
  | { type: 'warmup'; target: 'background' }
  | { type: 'retry'; target: 'background' }
  | { type: 'check'; target: 'background'; requestId: string; text: string; origin?: string }
  | { type: 'correct'; target: 'background'; requestId: string; text: string }
  | { type: 'settings:get'; target: 'background' }
  | { type: 'settings:set'; target: 'background'; patch: Partial<Settings> }
  | { type: 'site:enabled'; target: 'background'; origin: string }
  | { type: 'models:list'; target: 'background' }
  | { type: 'models:download'; target: 'background'; modelId: string }
  | { type: 'models:delete'; target: 'background'; modelId: string };

// ---- Messages addressed to the offscreen document ----

export type OffscreenMessage =
  | { type: 'status'; target: 'offscreen' }
  | { type: 'warmup'; target: 'offscreen' }
  | { type: 'reload'; target: 'offscreen' }
  | { type: 'check'; target: 'offscreen'; requestId: string; text: string }
  | { type: 'config'; target: 'offscreen'; config: RunnerConfig }
  | { type: 'download'; target: 'offscreen'; modelId: string };

// ---- Messages addressed to a page's content script (via chrome.tabs.sendMessage) ----

export type ContentMessage =
  | { type: 'gc-correcting'; target: 'content' }
  | {
      type: 'gc-correct-result';
      target: 'content';
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
  state: 'downloading' | 'done' | 'error';
  progress: number;
  error?: string;
}

export function isBackgroundMessage(msg: unknown): msg is BackgroundMessage {
  return typeof msg === 'object' && msg !== null && 'target' in msg && msg.target === 'background';
}

export function isOffscreenMessage(msg: unknown): msg is OffscreenMessage {
  return typeof msg === 'object' && msg !== null && 'target' in msg && msg.target === 'offscreen';
}

export function isStatusBroadcast(msg: unknown): msg is StatusBroadcast {
  return (
    typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'status:changed'
  );
}

export function isDownloadProgress(msg: unknown): msg is DownloadProgress {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: string }).type === 'download:progress'
  );
}

export function isContentMessage(msg: unknown): msg is ContentMessage {
  return typeof msg === 'object' && msg !== null && 'target' in msg && msg.target === 'content';
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
