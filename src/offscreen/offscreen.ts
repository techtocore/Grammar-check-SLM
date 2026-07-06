import { Corrector } from './corrector';
import {
  broadcastStatus,
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOffscreenMessage(message)) return undefined;

  switch (message.type) {
    case 'config': {
      getCorrector().setConfig(message.config);
      sendResponse({ ok: true });
      return true;
    }
    case 'status': {
      sendResponse(corrector ? corrector.getStatus() : latestStatus);
      return true;
    }
    case 'warmup': {
      // Fire-and-forget: start loading and report progress via status broadcasts.
      void getCorrector()
        .ensureLoaded()
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
      const { modelId } = message;
      void getCorrector()
        .downloadModel(modelId)
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
