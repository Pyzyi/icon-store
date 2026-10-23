import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, SESSION_SWEEP_INTERVAL_MS, SESSION_TOKEN_BYTES } from '../constants.js';
import { AppError } from './errors.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** @param {string} s */
function digest(s) {
  return createHash('sha256').update(s, 'utf8').digest();
}

/**
 * Hashing first gives both sides the same length, so timingSafeEqual neither
 * throws nor leaks the key length.
 * @param {string | null} adminKey
 */
export function createKeyVerifier(adminKey) {
  const expected = adminKey === null ? null : digest(adminKey);
  /** @param {unknown} candidate */
  return (candidate) =>
    expected !== null && typeof candidate === 'string' && timingSafeEqual(digest(candidate), expected);
}

/**
 * In-memory sessions. Losing them on restart only means logging in again,
 * which is cheaper than another dependency plus a persistent secret store.
 */
export class SessionStore {
  /** @type {Map<string, { expires: number }>} keyed by SHA-256 of the token so a heap dump does not reveal live cookies */
  #sessions = new Map();
  #ttlMs;
  /** @type {NodeJS.Timeout} */
  #timer;

  /** @param {number} ttlMs */
  constructor(ttlMs) {
    this.#ttlMs = ttlMs;
    this.#timer = setInterval(() => this.sweep(), SESSION_SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  create() {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    this.#sessions.set(this.#key(token), { expires: Date.now() + this.#ttlMs });
    return token;
  }

  /** Sliding expiry: active admins stay logged in, idle sessions run out. @param {string | undefined} token */
  touch(token) {
    if (!token) return false;
    const key = this.#key(token);
    const s = this.#sessions.get(key);
    if (!s) return false;
    if (s.expires < Date.now()) {
      this.#sessions.delete(key);
      return false;
    }
    s.expires = Date.now() + this.#ttlMs;
    return true;
  }

  /** @param {string | undefined} token */
  destroy(token) {
    if (token) this.#sessions.delete(this.#key(token));
  }

  sweep() {
    const now = Date.now();
    for (const [k, s] of this.#sessions) if (s.expires < now) this.#sessions.delete(k);
  }

  close() {
    clearInterval(this.#timer);
  }

  /** @param {string} token */
  #key(token) {
    return digest(token).toString('hex');
  }
}

/**
 * @param {string | undefined} header
 * @param {string} name
 */
export function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * @param {import('express').Request} req
 * @param {import('../config.js').Config['cookieSecure']} mode
 */
export function isSecureCookie(req, mode) {
  if (mode === 'auto') return req.secure;
  return mode === 'true';
}

/**
 * @param {{ sessions: SessionStore, verifyKey: (k: unknown) => boolean, config: import('../config.js').Config }} deps
 */
export function createAuth({ sessions, verifyKey, config }) {
  /** @param {import('express').Request} req */
  const bearerOk = (req) => {
    if (!config.allowApiBearer) return false;
    const header = req.get('authorization') ?? '';
    return header.startsWith('Bearer ') && verifyKey(header.slice('Bearer '.length).trim());
  };

  /** @type {import('express').RequestHandler} */
  const identify = (req, res, next) => {
    const viaBearer = bearerOk(req);
    res.locals.viaBearer = viaBearer;
    res.locals.authenticated =
      config.insecureNoAuth || viaBearer || sessions.touch(readCookie(req.get('cookie'), SESSION_COOKIE));
    next();
  };

  /** @type {import('express').RequestHandler} */
  const requireAuth = (req, res, next) => {
    if (res.locals.authenticated) return next();
    next(new AppError(401, 'auth_required'));
  };

  /**
   * CSRF defence in depth on top of SameSite=Strict: browsers always send
   * Origin on cross-site state-changing requests, so a foreign or missing
   * Origin is refused. Bearer clients are exempt – a browser cannot attach
   * that header cross-site.
   * @type {import('express').RequestHandler}
   */
  const checkOrigin = (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method) || res.locals.viaBearer) return next();
    const origin = req.get('origin') ?? originOf(req.get('referer'));
    if (origin && isAllowedOrigin(origin, req, config.allowedOrigins)) return next();
    next(new AppError(403, 'forbidden_origin'));
  };

  return { identify, requireAuth, checkOrigin };
}

/** @param {string | undefined} url */
function originOf(url) {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Compare host[:port] only: behind a TLS-terminating proxy the app sees http
 * while the browser says https, yet both name the same host.
 * @param {string} origin
 * @param {import('express').Request} req
 * @param {string[]} allowed
 */
function isAllowedOrigin(origin, req, allowed) {
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}
