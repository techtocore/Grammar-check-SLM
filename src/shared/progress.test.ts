import { describe, expect, it } from 'vitest';

import { progressPercentage } from './progress';

describe('progressPercentage', () => {
  it('supports Prompt API ratio progress', () => {
    expect(progressPercentage({ lengthComputable: false, loaded: 0.42, total: 0 })).toBe(42);
  });

  it('supports standard byte progress', () => {
    expect(progressPercentage({ lengthComputable: true, loaded: 30, total: 120 })).toBe(25);
  });

  it('clamps invalid event ranges', () => {
    expect(progressPercentage({ lengthComputable: false, loaded: -1, total: 0 })).toBe(0);
    expect(progressPercentage({ lengthComputable: false, loaded: 2, total: 0 })).toBe(100);
  });
});
