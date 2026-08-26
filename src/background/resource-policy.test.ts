import { describe, expect, it } from 'vitest';

import {
  RECENT_ACTIVITY_MS,
  STARTUP_WARMUP_ALARM_PREFIX,
  startupWarmupAlarm,
  startupWarmupAttempt,
  usedRecently,
} from './resource-policy';

describe('runner resource policy', () => {
  it('round-trips startup warmup attempts', () => {
    expect(startupWarmupAlarm(3)).toBe(`${STARTUP_WARMUP_ALARM_PREFIX}3`);
    expect(startupWarmupAttempt(startupWarmupAlarm(3))).toBe(3);
    expect(startupWarmupAttempt('unrelated')).toBeNull();
    expect(startupWarmupAttempt(`${STARTUP_WARMUP_ALARM_PREFIX}bad`)).toBeNull();
  });

  it('prewarms only for recent valid activity', () => {
    const now = 1_800_000_000_000;
    expect(usedRecently(now - RECENT_ACTIVITY_MS, now)).toBe(true);
    expect(usedRecently(now - RECENT_ACTIVITY_MS - 1, now)).toBe(false);
    expect(usedRecently(now + 1, now)).toBe(false);
    expect(usedRecently(null, now)).toBe(false);
  });
});
