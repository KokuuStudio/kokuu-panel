/**
 * 极简结构化日志。
 *
 * 不用 pino/winston：这个服务的日志量不大，而依赖越少，
 * 部署时出问题的面越小。需要接入集中式日志时，
 * 把 `write` 换成往 stdout 打 JSON 一行即可。
 */

import { config } from './config.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as LogLevel) ?? 'info'] ?? LEVELS.info;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;

  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger('server');
