import { isSiteEnabled, loadSettings, onSettingsChanged, originOf } from '../shared/settings';
import { Tooltip } from './tooltip';
import { FieldRegistry } from './registry';
import { initSelectionCorrection } from './selection';
import { onContextInvalidated } from './lifecycle';
import { createLogger } from '../shared/logger';

const log = createLogger('content');

/**
 * The origin whose per-site rules govern this frame, or null if this frame
 * should not run at all.
 *
 * - Top document: its own origin.
 * - Same-origin subframe (including opaque about:blank/srcdoc editor iframes like
 *   TinyMCE/CKEditor): the top document's origin, so it inherits the page's rules.
 * - Cross-origin subframe (ads, third-party embeds): null — reading
 *   `top.location.href` throws, so these frames are skipped entirely.
 */
function governingOrigin(): string | null {
  if (window.top === window.self) return originOf(location.href);
  try {
    const top = window.top;
    return top ? originOf(top.location.href) : null;
  } catch {
    return null;
  }
}

/**
 * Whether to run in this frame. The top document always runs; a subframe runs
 * only when it is same-origin with the top (so it resolved a governing origin).
 */
function shouldRunInFrame(origin: string | null): boolean {
  if (window.top === window.self) return true;
  return origin !== null;
}

async function main(): Promise<void> {
  // Selection correction is explicitly user-triggered and works even where
  // automatic checking is disabled, including cross-origin subframes.
  initSelectionCorrection();

  const origin = governingOrigin();
  if (!shouldRunInFrame(origin)) return;

  const settings = await loadSettings();
  const tooltip = new Tooltip();
  const registry = new FieldRegistry(settings, tooltip, origin);

  if (isSiteEnabled(settings, origin)) registry.start();

  const unsubscribe = onSettingsChanged((next) => {
    registry.updateSettings(next, isSiteEnabled(next, origin));
  });

  // If the extension is reloaded/updated/removed while this page is open, stop
  // all work so the orphaned content script doesn't keep erroring.
  onContextInvalidated(() => {
    registry.stop();
    tooltip.destroy();
    unsubscribe();
  });

  log.info(`Content script initialised (origin=${origin ?? 'unsupported'}).`);
}

void main();
