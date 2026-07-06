import { isSiteEnabled, loadSettings, onSettingsChanged, originOf } from '../shared/settings';
import { Tooltip } from './tooltip';
import { FieldRegistry } from './registry';
import { createLogger } from '../shared/logger';

const log = createLogger('content');

async function main(): Promise<void> {
  const settings = await loadSettings();
  // Use the same origin normalization the background uses, so the two agree.
  const origin = originOf(location.href);
  const tooltip = new Tooltip();
  const registry = new FieldRegistry(settings, tooltip);

  if (isSiteEnabled(settings, origin)) registry.start();

  onSettingsChanged((next) => {
    registry.updateSettings(next, isSiteEnabled(next, origin));
  });

  log.info(`Content script initialised (origin=${origin ?? 'unsupported'}).`);
}

void main();
