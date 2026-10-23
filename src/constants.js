/**
 * Fixed values shared across modules. Anything an operator might reasonably
 * want to change lives in config.js instead.
 */

/** @typedef {'raster' | 'svg' | 'ico'} IconKind */

/**
 * The only file types we accept and the only Content-Type values we will ever
 * send for them. Serving from this table (instead of guessing from the
 * extension at request time) means a stored file can never be delivered as
 * text/html, no matter how it was named.
 * @type {Readonly<Record<string, { mime: string, kind: IconKind, detected: string }>>}
 */
export const FILE_TYPES = Object.freeze({
  png: { mime: 'image/png', kind: 'raster', detected: 'png' },
  jpg: { mime: 'image/jpeg', kind: 'raster', detected: 'jpg' },
  jpeg: { mime: 'image/jpeg', kind: 'raster', detected: 'jpg' },
  webp: { mime: 'image/webp', kind: 'raster', detected: 'webp' },
  gif: { mime: 'image/gif', kind: 'raster', detected: 'gif' },
  ico: { mime: 'image/x-icon', kind: 'ico', detected: 'ico' },
  svg: { mime: 'image/svg+xml', kind: 'svg', detected: 'svg' },
});

export const ALLOWED_EXTENSIONS = Object.freeze(Object.keys(FILE_TYPES));

export const LIMITS = Object.freeze({
  NAME_MAX_LENGTH: 100,
  TAG_MAX_COUNT: 20,
  TAG_MAX_LENGTH: 32,
  JSON_BODY_BYTES: 16 * 1024,
  /** Multipart text fields (name, tags) – generous for 20 × 32 chars. */
  FORM_FIELD_BYTES: 4 * 1024,
  /** Decompression-bomb guard for sharp: 8192 × 8192 is far beyond any icon. */
  MAX_INPUT_PIXELS: 8192 * 8192,
  ZIP_MAX_ENTRIES: 50_000,
});

/** Random suffix of new filenames. Same alphabet/length as v1 so URLs look identical. */
export const SUFFIX = Object.freeze({
  LENGTH: 10,
  ALPHABET: 'abcdefghijklmnopqrstuvwxyz0123456789',
});

export const METADATA_VERSION = 2;
export const METADATA_FILE = 'metadata.json';
export const METADATA_V1_BACKUP = 'metadata.v1.bak.json';
export const ICONS_SUBDIR = 'icons';
/** Prefix for in-flight files; the startup check removes leftovers after a crash. */
export const TMP_PREFIX = '.tmp-';

export const SESSION_COOKIE = 'iconstore_sid';
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export const ICON_CACHE_SECONDS = 365 * 24 * 60 * 60;

/** Headers for user-supplied files: even a malicious SVG that slipped through sanitising cannot run script or load anything. */
export const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Minimum ADMIN_KEY length; 32 hex chars = 128 bit. */
export const MIN_ADMIN_KEY_LENGTH = 32;
