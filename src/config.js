import path from 'node:path';
import { MIN_ADMIN_KEY_LENGTH } from './constants.js';

const MB = 1024 * 1024;

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host
 * @property {string} dataDir
 * @property {string | null} adminKey null only when insecureNoAuth is set
 * @property {boolean} insecureNoAuth
 * @property {number} maxUploadBytes
 * @property {number} maxTotalBytes
 * @property {number} maxImportBytes
 * @property {number} maxConcurrentUploads
 * @property {boolean | number | string} trustProxy
 * @property {'auto' | 'true' | 'false'} cookieSecure
 * @property {number} sessionTtlMs
 * @property {number} loginRateLimit attempts per minute per IP
 * @property {number} uploadRateLimit uploads per 10 minutes per IP
 * @property {boolean} publicBrowse
 * @property {boolean} allowApiBearer
 * @property {boolean} reencodeRaster
 * @property {string[]} allowedOrigins
 * @property {string | undefined} auditLogFile
 * @property {'debug' | 'info' | 'warn' | 'error'} logLevel
 */

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/** Values from our own docs/compose file that must never be accepted as a real key. */
const PLACEHOLDER_PATTERN = /change|aendern|ändern|replace|example|placeholder|xxxx/i;

/**
 * Read and validate the whole configuration up front. Any problem aborts the
 * start – running with a half-valid config is how the original ended up
 * without authentication.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Config}
 */
export function loadConfig(env) {
  /** @type {string[]} */
  const problems = [];
  const r = reader(env, problems);

  const insecureNoAuth = r.bool('ALLOW_INSECURE_NO_AUTH', false);
  const adminKey = validateAdminKey(env.ADMIN_KEY, insecureNoAuth, problems);

  /** @type {Config} */
  const config = {
    port: r.int('PORT', 3000, 1, 65535),
    host: r.str('HOST', '0.0.0.0'),
    dataDir: path.resolve(r.str('DATA_DIR', path.join(process.cwd(), 'data'))),
    adminKey,
    insecureNoAuth,
    maxUploadBytes: r.int('MAX_UPLOAD_MB', 8, 1, 100) * MB,
    maxTotalBytes: r.int('MAX_TOTAL_SIZE_MB', 1024, 1, 1024 * 1024) * MB,
    maxImportBytes: r.int('MAX_IMPORT_MB', 1024, 1, 1024 * 1024) * MB,
    maxConcurrentUploads: r.int('MAX_CONCURRENT_UPLOADS', 4, 1, 64),
    trustProxy: parseTrustProxy(r.str('TRUST_PROXY', 'false')),
    cookieSecure: r.oneOf('COOKIE_SECURE', 'auto', ['auto', 'true', 'false']),
    sessionTtlMs: r.int('SESSION_TTL_HOURS', 12, 1, 24 * 30) * 60 * 60 * 1000,
    loginRateLimit: r.int('LOGIN_RATE_LIMIT', 5, 1, 1000),
    uploadRateLimit: r.int('UPLOAD_RATE_LIMIT', 120, 1, 100_000),
    publicBrowse: r.bool('PUBLIC_BROWSE', false),
    allowApiBearer: r.bool('ALLOW_API_BEARER', false),
    reencodeRaster: r.bool('REENCODE_RASTER', true),
    allowedOrigins: r.list('ALLOWED_ORIGINS').map((o) => o.replace(/\/+$/, '')),
    auditLogFile: env.AUDIT_LOG_FILE ? path.resolve(env.AUDIT_LOG_FILE) : undefined,
    logLevel: r.oneOf('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
  };

  for (const origin of config.allowedOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin))
      problems.push(`ALLOWED_ORIGINS: "${origin}" is not an origin like https://icons.example.org`);
  }

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}

/**
 * @param {string | undefined} raw
 * @param {boolean} insecureNoAuth
 * @param {string[]} problems
 * @returns {string | null}
 */
function validateAdminKey(raw, insecureNoAuth, problems) {
  const key = raw?.trim() ?? '';
  if (!key) {
    if (insecureNoAuth) return null;
    problems.push(
      `ADMIN_KEY is missing. Generate one with "openssl rand -hex 32" (min. ${MIN_ADMIN_KEY_LENGTH} chars).`,
    );
    return null;
  }
  if (key.length < MIN_ADMIN_KEY_LENGTH) {
    problems.push(
      `ADMIN_KEY is too short (${key.length} chars, min. ${MIN_ADMIN_KEY_LENGTH}). Use "openssl rand -hex 32".`,
    );
  } else if (PLACEHOLDER_PATTERN.test(key)) {
    problems.push('ADMIN_KEY still contains the placeholder from the example. Use "openssl rand -hex 32".');
  }
  return key;
}

/** @param {string} raw @returns {boolean | number | string} */
function parseTrustProxy(raw) {
  if (raw === 'true') return true;
  if (raw === 'false' || raw === '') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // e.g. "loopback, 10.0.0.0/8" – passed to Express as is
}

/**
 * Small typed accessors that collect problems instead of throwing on the
 * first one, so the operator sees everything wrong in one go.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} problems
 */
function reader(env, problems) {
  /** @param {string} name */
  const get = (name) => {
    const v = env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  return {
    /** @param {string} name @param {string} def */
    str: (name, def) => get(name) ?? def,
    /** @param {string} name @returns {string[]} */
    list: (name) =>
      (get(name) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    /** @param {string} name @param {boolean} def */
    bool(name, def) {
      const v = get(name)?.toLowerCase();
      if (v === undefined) return def;
      if (['true', '1', 'yes'].includes(v)) return true;
      if (['false', '0', 'no'].includes(v)) return false;
      problems.push(`${name} must be true or false`);
      return def;
    },
    /** @param {string} name @param {number} def @param {number} min @param {number} max */
    int(name, def, min, max) {
      const v = get(name);
      if (v === undefined) return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        problems.push(`${name} must be an integer between ${min} and ${max}`);
        return def;
      }
      return n;
    },
    /**
     * @template {string} T
     * @param {string} name @param {T} def @param {readonly T[]} allowed
     * @returns {T}
     */
    oneOf(name, def, allowed) {
      const v = /** @type {T | undefined} */ (get(name)?.toLowerCase());
      if (v === undefined) return def;
      if (allowed.includes(v)) return v;
      problems.push(`${name} must be one of: ${allowed.join(', ')}`);
      return def;
    },
  };
}
