import { appendFile } from 'node:fs/promises';

/** @typedef {'debug' | 'info' | 'warn' | 'error'} Level */
/** @typedef {{ debug: LogFn, info: LogFn, warn: LogFn, error: LogFn }} Logger */
/** @typedef {(msg: string, fields?: Record<string, unknown>) => void} LogFn */

const LEVELS = /** @type {const} */ (['debug', 'info', 'warn', 'error']);

/**
 * JSON-lines logger on stdout/stderr: `docker logs` keeps them and they are
 * trivially machine-readable, so no logging library is needed.
 * @param {{ level?: Level, write?: (line: string, level: Level) => void }} [opts]
 * @returns {Logger}
 */
export function createLogger({ level = 'info', write = defaultWrite } = {}) {
  const min = LEVELS.indexOf(level);
  /** @param {Level} lvl */
  const make = (lvl) =>
    /** @type {LogFn} */ (
      (msg, fields = {}) => {
        if (LEVELS.indexOf(lvl) < min) return;
        write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }), lvl);
      }
    );
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

/** @param {string} line @param {Level} level */
function defaultWrite(line, level) {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

/** @typedef {(event: string, fields: Record<string, unknown>) => void} AuditFn */

/**
 * Security-relevant events (login, upload, edit, delete, import). Callers pass
 * only non-secret fields; the admin key is never part of any event.
 * @param {Logger} log
 * @param {string | undefined} file optional additional append-only file
 * @returns {AuditFn}
 */
export function createAudit(log, file) {
  let chain = Promise.resolve();
  return (event, fields) => {
    const record = { audit: event, ...fields };
    log.info('audit', record);
    if (!file) return;
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`;
    // Serialise appends so lines never interleave.
    chain = chain
      .then(() => appendFile(file, line, { mode: 0o600 }))
      .catch((err) => log.error('audit log write failed', { err: String(err) }));
  };
}
