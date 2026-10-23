import { createApp } from './app.js';
import { createKeyVerifier, SessionStore } from './lib/auth.js';
import { checkConsistency } from './lib/consistency.js';
import { createAudit, createLogger } from './lib/log.js';
import { Store, StorageError } from './lib/storage.js';
import { ConfigError, loadConfig } from './config.js';
import { SHUTDOWN_TIMEOUT_MS } from './constants.js';

/** Exit code for "refusing to start" so orchestrators can tell it from a crash. */
const EXIT_CONFIG = 78;

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(
        `\n[icon-store] ${err.message}\n\nThe app will not start without a valid configuration.\n\n`,
      );
      process.exit(EXIT_CONFIG);
    }
    throw err;
  }

  const log = createLogger({ level: config.logLevel });
  if (config.insecureNoAuth) {
    log.warn(
      '!!! ALLOW_INSECURE_NO_AUTH=true – AUTHENTICATION IS DISABLED. Anyone who can reach this port can upload and delete icons. !!!',
    );
  }

  const store = new Store({ dataDir: config.dataDir, maxTotalBytes: config.maxTotalBytes, log });
  try {
    await store.init();
  } catch (err) {
    reportStartupFailure(log, err, config.dataDir);
    process.exit(EXIT_CONFIG);
  }
  await checkConsistency(store, log);

  const sessions = new SessionStore(config.sessionTtlMs);
  const app = createApp({
    config,
    store,
    sessions,
    verifyKey: createKeyVerifier(config.adminKey),
    log,
    audit: createAudit(log, config.auditLogFile),
  });

  const server = app.listen(config.port, config.host, () => {
    log.info('icon store listening', { host: config.host, port: config.port, dataDir: config.dataDir });
  });

  let stopping = false;
  /** @param {NodeJS.Signals} signal */
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => {
      log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    // Stop accepting connections, let running requests finish, then wait for queued writes.
    server.close(async () => {
      await store.idle();
      sessions.close();
      log.info('shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * @param {import('./lib/log.js').Logger} log
 * @param {unknown} err
 * @param {string} dataDir
 */
function reportStartupFailure(log, err, dataDir) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    log.error(
      `DATA_DIR ${dataDir} is not writable for this user (uid ${process.getuid?.()}). ` +
        `When migrating from the old version run: chown -R 1000:1000 <your data folder>`,
    );
  } else if (err instanceof StorageError) {
    log.error(err.message);
  } else {
    log.error('could not initialise storage', { err: String(err) });
  }
}

main().catch((err) => {
  process.stderr.write(`[icon-store] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
