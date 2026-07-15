import { Corrector } from './corrector';
import {
  broadcastStatus,
  isBackgroundSender,
  isOffscreenMessage,
  type CheckResult,
  type ModelStatus,
} from '../shared/messages';
import { createLogger } from '../shared/logger';

const log = createLogger('offscreen');

let corrector: Corrector | null = null;
let latestStatus: ModelStatus = { state: 'idle', progress: 0, modelId: '', device: 'unknown' };

function getCorrector(): Corrector {
  if (!corrector) {
    corrector = new Corrector((status) => {
      latestStatus = status;
      broadcastStatus(status);
    });
  }
  return corrector;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOffscreenMessage(message)) return undefined;
  if (!isBackgroundSender(sender, chrome.runtime.id)) {
    log.warn(`Rejected unauthorized ${message.type} message.`);
    return undefined;
  }

  switch (message.type) {
    case 'config': {
      void getCorrector()
        .setConfig(message.config)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          log.error('Configuration failed.', error);
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }
    case 'status': {
      sendResponse(corrector ? corrector.getStatus() : latestStatus);
      return true;
    }
    case 'warmup': {
      // Fire-and-forget: start loading and report progress via status broadcasts.
      void getCorrector()
        .warmup()
        .catch((error: unknown) => log.error('Warmup failed.', error));
      sendResponse(getCorrector().getStatus());
      return true;
    }
    case 'reload': {
      void getCorrector()
        .reload()
        .catch((error: unknown) => log.error('Reload failed.', error));
      sendResponse(getCorrector().getStatus());
      return true;
    }
    case 'download': {
      const { modelId, device } = message;
      void getCorrector()
        .downloadModel(modelId, device)
        .catch((error: unknown) => log.error('Download failed.', error));
      sendResponse({ ok: true });
      return true;
    }
    case 'check': {
      const { requestId, text } = message;
      void (async () => {
        try {
          const corrections = await getCorrector().correct(text);
          const result: CheckResult = { requestId, sourceText: text, corrections };
          sendResponse(result);
        } catch (error) {
          const result: CheckResult = {
            requestId,
            sourceText: text,
            corrections: [],
            error: error instanceof Error ? error.message : String(error),
          };
          sendResponse(result);
        }
      })();
      return true;
    }
    default:
      return undefined;
  }
});

log.info('Offscreen document ready.');
