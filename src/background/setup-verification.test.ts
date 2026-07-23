import { describe, expect, it } from 'vitest';

import type { CheckResult, ModelStatus } from '../shared/messages';
import { assertSetupVerified, SETUP_PROBE } from './setup-verification';

const READY: ModelStatus = {
  state: 'ready',
  progress: 100,
  modelId: 'local-model',
  device: 'wasm',
};

function result(corrections: CheckResult['corrections']): CheckResult {
  return {
    requestId: 'setup',
    sourceText: SETUP_PROBE,
    corrections,
    nextOffset: SETUP_PROBE.length,
    complete: true,
  };
}

describe('setup verification', () => {
  it('accepts a ready model that corrects the probe sentence', () => {
    expect(() =>
      assertSetupVerified(
        result([{ start: 4, end: 6, original: 'go', suggestion: 'goes', kind: 'replace' }]),
        READY,
      ),
    ).not.toThrow();
  });

  it('rejects a model that returns no correction', () => {
    expect(() => assertSetupVerified(result([]), READY)).toThrow(
      'did not correct the setup test sentence',
    );
  });

  it('rejects a runner that did not become ready', () => {
    expect(() =>
      assertSetupVerified(
        result([{ start: 4, end: 6, original: 'go', suggestion: 'goes', kind: 'replace' }]),
        {
          ...READY,
          state: 'error',
          message: 'Model failed to load',
        },
      ),
    ).toThrow('Model failed to load');
  });
});
