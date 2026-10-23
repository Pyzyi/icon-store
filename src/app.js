import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { LIMITS } from './constants.js';
import { createAuth } from './lib/auth.js';
import { AppError, errorHandler } from './lib/errors.js';
import { Semaphore } from './lib/mutex.js';
import { authRouter } from './routes/auth.js';
import { backupRouter } from './routes/backup.js';
import { filesRouter } from './routes/files.js';
import { iconsRouter } from './routes/icons.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const MINUTE = 60 * 1000;
const UPLOAD_WINDOW_MS = 10 * MINUTE;

/**
 * @typedef {object} AppDeps
 * @property {import('./config.js').Config} config
 * @property {import('./lib/storage.js').Store} store
 * @property {import('./lib/auth.js').SessionStore} sessions
 * @property {(key: unknown) => boolean} verifyKey
 * @property {import('./lib/log.js').Logger} log
 * @property {import('./lib/log.js').AuditFn} audit
 * @property {ReturnType<typeof createAuth>} auth
 */

/** @param {number} windowMs @param {number} limit */
function limiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'rate_limited')),
  });
}

/**
 * Fails fast with 503 when all upload slots are taken, so concurrent uploads
 * cannot buffer more than slots × MAX_UPLOAD_MB in memory.
 * @param {Semaphore} sem
 * @returns {import('express').RequestHandler}
 */
function uploadSlot(sem) {
  return (_req, res, next) => {
    if (!sem.tryAcquire()) return next(new AppError(503, 'server_busy'));
    res.once('close', () => sem.release());
    next();
  };
}

/** Strict policy for the UI: no inline script/style, no third-party origins. */
const uiHelmet = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  // HSTS belongs to the TLS-terminating proxy; sending it from a plain-HTTP LAN app helps nobody.
  strictTransportSecurity: false,
  referrerPolicy: { policy: 'same-origin' },
});

/** @param {Omit<AppDeps, 'auth'>} deps */
export function createApp(deps) {
  const { config, log } = deps;
  const auth = createAuth(deps);
  /** @type {AppDeps} */
  const full = { ...deps, auth };
  const uploadGuards = [
    limiter(UPLOAD_WINDOW_MS, config.uploadRateLimit),
    auth.requireAuth,
    uploadSlot(new Semaphore(config.maxConcurrentUploads)),
  ];
  const browseGuard = config.publicBrowse
    ? /** @type {import('express').RequestHandler} */ (_q, _s, n) => n()
    : auth.requireAuth;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  // Before helmet: icons need their own, cross-origin-friendly headers.
  app.use('/icons', filesRouter(full));

  app.use(uiHelmet);
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(auth.identify, auth.checkOrigin);
  api.use(express.json({ limit: LIMITS.JSON_BODY_BYTES }));
  api.use(authRouter({ ...full, loginLimiter: limiter(MINUTE, config.loginRateLimit) }));
  api.use(iconsRouter({ ...full, uploadGuards, browseGuard }));
  api.use(backupRouter({ ...full, uploadGuards }));
  api.use((_req, _res, next) => next(new AppError(404, 'not_found')));
  app.use('/api', api);

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'ignore', maxAge: 0 }));
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use(errorHandler(log));
  return app;
}
