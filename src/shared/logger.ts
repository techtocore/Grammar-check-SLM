// Tiny namespaced logger. Prefixes messages so extension contexts
// (background / offscreen / content / popup) are easy to tell apart in devtools.

type Level = 'debug' | 'info' | 'warn' | 'error';

const STYLES: Record<Level, string> = {
  debug: 'color:#888',
  info: 'color:#3b82f6',
  warn: 'color:#d97706',
  error: 'color:#dc2626',
};

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const log =
    (level: Level) =>
    (...args: unknown[]): void => {
      const prefix = `%c[GrammarSLM:${scope}]`;
      console[level](prefix, STYLES[level], ...args);
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
