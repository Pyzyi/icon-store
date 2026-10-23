import path from 'node:path';
import { ALLOWED_EXTENSIONS, LIMITS } from '../constants.js';
import { AppError } from './errors.js';

/** Control, format (zero-width, bidi overrides) and line/paragraph separator characters. */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT_GROUP = ALLOWED_EXTENSIONS.join('|');
/**
 * Filenames we are willing to touch on disk. Broader than what we generate
 * (<slug>_<10 chars>.<ext>) so that hand-placed v1 files keep working, but it
 * excludes separators, dot-files and "..".
 */
const SAFE_FILENAME_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\\.(${EXT_GROUP})$`, 'i');

/** @param {string} s */
function clean(s) {
  return s.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} raw
 * @param {string} fallback used when raw is empty (e.g. original filename)
 * @returns {string}
 */
export function normalizeName(raw, fallback) {
  const name = clean(typeof raw === 'string' ? raw : '') || clean(fallback);
  if (!name) throw new AppError(400, 'name_invalid');
  if (name.length > LIMITS.NAME_MAX_LENGTH) {
    throw new AppError(400, 'name_too_long', { max: LIMITS.NAME_MAX_LENGTH });
  }
  return name;
}

/**
 * Accepts the v1 wire format (comma-separated string) and arrays.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseTags(raw) {
  /** @type {unknown[]} */
  let parts;
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === 'string') parts = raw.split(',');
  else if (raw === undefined || raw === null) parts = [];
  else throw new AppError(400, 'invalid_body');

  const tags = [];
  for (const part of parts) {
    if (typeof part !== 'string') throw new AppError(400, 'invalid_body');
    const tag = clean(part).toLowerCase();
    if (!tag) continue;
    if (tag.length > LIMITS.TAG_MAX_LENGTH) {
      throw new AppError(400, 'tag_too_long', { max: LIMITS.TAG_MAX_LENGTH });
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > LIMITS.TAG_MAX_COUNT) {
    throw new AppError(400, 'too_many_tags', { max: LIMITS.TAG_MAX_COUNT });
  }
  return tags;
}

/** @param {unknown} id @returns {id is string} */
export function isUuid(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** @param {unknown} id */
export function assertUuid(id) {
  if (!isUuid(id)) throw new AppError(400, 'invalid_id');
  return id;
}

/**
 * True only for a bare, harmless filename. Using path.basename as well guards
 * against platform-specific separators the regex might not anticipate.
 * @param {unknown} name
 * @returns {name is string}
 */
export function isSafeFilename(name) {
  return typeof name === 'string' && path.basename(name) === name && SAFE_FILENAME_RE.test(name);
}

/** @param {string} filename lower-case extension without dot */
export function extensionOf(filename) {
  return path.extname(filename).slice(1).toLowerCase();
}

/** Same slug rules as v1 so new URLs look like the old ones. @param {string} name */
export function slugify(name) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'icon'
  );
}
