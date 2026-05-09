/**
 * stderr-only structured logger.
 *
 * IMPORTANT: MCP servers communicate over stdio — stdout is reserved for the
 * JSON-RPC wire protocol. Any stray write to stdout will corrupt the stream
 * and confuse the client. All logs MUST go to stderr.
 */

type Level = 'info' | 'warn' | 'error' | 'debug';

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const tail = fields
    ? ' ' +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')
    : '';
  process.stderr.write(`[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}${tail}\n`);
}

export const logger = {
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
};
