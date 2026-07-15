import { createLogger } from '../shared/logger';
import { FIRST_RUN_QUERY_PARAM, markFirstRunSetupPending } from '../shared/onboarding';

const log = createLogger('first-run');

/**
 * Opens a dedicated first-run Settings tab and records that setup is pending.
 * Updates do not reopen Settings or restart onboarding.
 */
export async function handleFirstRunInstall(
  details: chrome.runtime.InstalledDetails,
): Promise<void> {
  if (details.reason !== 'install') return;

  let setupPersisted = true;
  try {
    await markFirstRunSetupPending();
  } catch (error) {
    setupPersisted = false;
    // The query parameter still lets this installation complete setup even if
    // extension storage is temporarily unavailable.
    log.warn('Could not persist first-run setup state.', error);
  }

  const url = new URL(chrome.runtime.getURL('options.html'));
  url.searchParams.set(FIRST_RUN_QUERY_PARAM, '1');

  try {
    await chrome.tabs.create({ url: url.href, active: true });
  } catch (error) {
    log.warn('Could not create a dedicated first-run Settings tab.', error);
    if (!setupPersisted) {
      try {
        await markFirstRunSetupPending();
      } catch (retryError) {
        log.warn('Could not persist first-run setup state on retry.', retryError);
      }
    }
    await chrome.runtime.openOptionsPage();
  }
}
