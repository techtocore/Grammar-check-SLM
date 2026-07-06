// Tiny namespaced logger. Prefixes messages so extension contexts
// (background / offscreen / content / popup) are easy to tell apart. Uses a
// plain text prefix (no %c styling) so logs render correctly in the extensions
// error page as well as DevTools.

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const prefix = `[GrammarSLM:${scope}]`;
  const log =
    (level: Level) =>
    (...args: unknown[]): void => {
      console[level](prefix, ...args);
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
