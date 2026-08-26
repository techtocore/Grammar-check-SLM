export const STARTUP_WARMUP_ALARM_PREFIX = 'gcslm-startup-warmup:';
export const RUNNER_IDLE_ALARM = 'gcslm-runner-idle';

export const STARTUP_WARMUP_DELAY_MINUTES = 1;
export const STARTUP_RETRY_DELAY_MINUTES = 1;
export const MAX_STARTUP_WARMUP_ATTEMPTS = 5;
export const STARTUP_IDLE_THRESHOLD_SECONDS = 15;
export const RECENT_ACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;
export const RUNNER_IDLE_MINUTES = 5;
export const DOWNLOAD_IDLE_MINUTES = 30;

export function startupWarmupAlarm(attempt: number): string {
  return `${STARTUP_WARMUP_ALARM_PREFIX}${attempt}`;
}

export function startupWarmupAttempt(alarmName: string): number | null {
  if (!alarmName.startsWith(STARTUP_WARMUP_ALARM_PREFIX)) return null;
  const attempt = Number(alarmName.slice(STARTUP_WARMUP_ALARM_PREFIX.length));
  return Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : null;
}

export function usedRecently(lastUsedAt: number | null, now = Date.now()): boolean {
  return (
    lastUsedAt !== null &&
    Number.isFinite(lastUsedAt) &&
    lastUsedAt <= now &&
    now - lastUsedAt <= RECENT_ACTIVITY_MS
  );
}
