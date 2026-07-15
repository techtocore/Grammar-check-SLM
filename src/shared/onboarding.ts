const STORAGE_KEY = 'firstRunSetupPending';
let stateQueue: Promise<void> = Promise.resolve();

/** Query parameter used only for the tab opened immediately after installation. */
export const FIRST_RUN_QUERY_PARAM = 'firstRun';

function queueStateWrite(task: () => Promise<void>): Promise<void> {
  const operation = stateQueue.then(task, task);
  stateQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

/** Whether the one-time local-model setup still needs to finish. */
export async function isFirstRunSetupPending(): Promise<boolean> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] === true;
}

/** Marks first-run setup as pending before the Settings page is opened. */
export function markFirstRunSetupPending(): Promise<void> {
  return queueStateWrite(() => chrome.storage.local.set({ [STORAGE_KEY]: true }));
}

/** Clears the first-run marker after the recommended local model is cached. */
export function completeFirstRunSetup(): Promise<void> {
  return queueStateWrite(() => chrome.storage.local.remove(STORAGE_KEY));
}
