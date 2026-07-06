import { isSiteEnabled, loadSettings, onSettingsChanged } from '../shared/settings';
import { Tooltip } from './tooltip';
import { FieldRegistry } from './registry';
import { createLogger } from '../shared/logger';

const log = createLogger('content');

async function main(): Promise<void> {
  const settings = await loadSettings();
  const origin = location.origin;
  const tooltip = new Tooltip();
  const registry = new FieldRegistry(settings, tooltip);

  if (isSiteEnabled(settings, origin)) registry.start();

  onSettingsChanged((next) => {
    registry.updateSettings(next, isSiteEnabled(next, origin));
  });

  log.info('Content script initialised.');
}

void main();
