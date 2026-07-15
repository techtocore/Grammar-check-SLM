import { Corrector } from './corrector';
import { detectWebGPU } from './backends';
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

function queuedLoadingStatus(status: ModelStatus, message: string): ModelStatus {
  return {
    ...status,
    state: 'loading',
    progress: status.state === 'loading' ? status.progress : 0,
    error: undefined,
    message,
  };
}

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
      const runner = getCorrector();
      void runner.warmup().catch((error: unknown) => log.error('Warmup failed.', error));
      const status = runner.getStatus();
      sendResponse(
        status.state === 'idle' ? queuedLoadingStatus(status, 'Model load queued.') : status,
      );
      return true;
    }
    case 'reload': {
      const runner = getCorrector();
      void runner.reload().catch((error: unknown) => log.error('Reload failed.', error));
      sendResponse(queuedLoadingStatus(runner.getStatus(), 'Model retry queued.'));
      return true;
    }
    case 'suspend': {
      void getCorrector()
        .suspend()
        .catch((error: unknown) => log.error('Model suspension failed.', error));
      sendResponse({ ok: true });
      return true;
    }
    case 'device:detect': {
      void detectWebGPU().then((hasWebGPU) => sendResponse({ hasWebGPU }));
      return true;
    }
    case 'onboarding:select': {
      try {
        sendResponse(getCorrector().selectOnboardingTarget(message.modelId, message.device));
      } catch (error) {
        sendResponse({
          hasMatchingRunning: false,
          hasObsoleteRunning: false,
          hasMatchingRunnerLoading: false,
          hasObsoleteRunnerLoading: false,
          clearedObsoleteStatus: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
    case 'downloads:status': {
      sendResponse(corrector?.getDownloadStatuses() ?? []);
      return true;
    }
    case 'download:delete': {
      void getCorrector()
        .deleteModel(message.modelId)
        .then((deleted) => sendResponse({ ok: true, deleted }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            deleted: 0,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    case 'download': {
      const { modelId, device, purpose } = message;
      void getCorrector()
        .downloadModel(modelId, device, purpose)
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
