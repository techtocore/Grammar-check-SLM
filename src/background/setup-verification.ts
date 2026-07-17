import { applyCorrections } from '../core/corrections';
import type { CheckResult, ModelStatus } from '../shared/messages';

export const SETUP_PROBE = 'She go to school every day.';

export function assertSetupVerified(result: CheckResult, status: ModelStatus): void {
  if (result.error) throw new Error(result.error);
  if (
    result.sourceText !== SETUP_PROBE ||
    result.corrections.length === 0 ||
    applyCorrections(SETUP_PROBE, result.corrections) === SETUP_PROBE
  ) {
    throw new Error('The model loaded but did not correct the setup test sentence.');
  }
  if (status.state !== 'ready') {
    throw new Error(status.message ?? 'The grammar model did not become ready.');
  }
}
