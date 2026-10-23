import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  FILE_TYPES,
  ICONS_SUBDIR,
  LIMITS,
  METADATA_FILE,
  METADATA_V1_BACKUP,
  METADATA_VERSION,
  SUFFIX,
  TMP_PREFIX,
} from '../constants.js';
import { AppError } from './errors.js';
import { Mutex } from './mutex.js';
import { buildSearchIndex, search } from './search.js';
import { extensionOf, isSafeFilename, isUuid, normalizeName, parseTags, slugify } from './validate.js';

/**
 * @typedef {object} Icon
 * @property {string} id
 * @property {string} name
 * @property {string} filename
 * @property {string[]} tags
 * @property {number} size
 * @property {string} uploadedAt ISO date
 * @property {string} [updatedAt]
 * @property {string} contentType
 * @property {string} sha256
 */

export class StorageError extends Error {}

/** @param {Buffer} buf */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function randomSuffix() {
  let out = '';
  for (let i = 0; i < SUFFIX.LENGTH; i++) out += SUFFIX.ALPHABET[randomInt(SUFFIX.ALPHABET.length)];
  return out;
}

/**
 * Write via temp file + fsync + rename: readers and a crash at any point see
 * either the old or the new content, never a truncated file.
 * @param {string} target
 * @param {Buffer | string} data
 */
export async function writeFileAtomic(target, data) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `${TMP_PREFIX}${randomBytes(8).toString('hex')}`);
  const handle = await fs.open(tmp, 'wx', 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await syncDir(dir);
}

/** Persist the rename itself. Not supported everywhere, hence best effort. @param {string} dir */
async function syncDir(dir) {
  try {
    const h = await fs.open(dir, 'r');
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    /* e.g. Windows – rename is still atomic there */
  }
}

/**
 * Owns metadata.json and the icons directory. All mutations go through one
 * mutex, the in-memory copy is only replaced after the file has been written,
 * so memory and disk never disagree.
 */
export class Store {
  /** @type {Icon[]} newest first, like v1 */
  #icons = [];
  /** @type {Map<string, Icon>} */
  #byId = new Map();
  /** @type {Map<string, Icon>} */
  #byFilename = new Map();
  #totalSize = 0;
  #mutex = new Mutex();
  #maxTotalBytes;
  /** @type {import('./log.js').Logger} */
  #log;
  /** @type {ReturnType<typeof buildSearchIndex>} */
  #index = buildSearchIndex([]);

  /**
   * @param {{ dataDir: string, maxTotalBytes: number, log: import('./log.js').Logger }} opts
   */
  constructor({ dataDir, maxTotalBytes, log }) {
    this.dataDir = dataDir;
    this.iconsDir = path.join(dataDir, ICONS_SUBDIR);
    this.metadataPath = path.join(dataDir, METADATA_FILE);
    this.#maxTotalBytes = maxTotalBytes;
    this.#log = log;
  }

  async init() {
    await fs.mkdir(this.iconsDir, { recursive: true });
    const raw = await this.#readMetadataFile();
    if (raw === null) {
      await this.#persist([]);
      return;
    }
    const doc = parseMetadata(raw, this.metadataPath);
    if (doc.version === METADATA_VERSION) {
      this.#replace(doc.icons.map(normalizeStored));
      return;
    }
    await this.#migrateV1(raw, doc.icons);
  }

  /** @returns {Promise<string | null>} */
  async #readMetadataFile() {
    try {
      return await fs.readFile(this.metadataPath, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * v1 entries lack contentType/sha256 and may carry loosely-typed fields.
   * The original file is kept as a backup before anything is rewritten.
   * @param {string} raw
   * @param {unknown[]} entries
   */
  async #migrateV1(raw, entries) {
    const backup = path.join(this.dataDir, METADATA_V1_BACKUP);
    await fs.writeFile(backup, raw, { flag: 'wx' }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
    /** @type {Icon[]} */
    const icons = [];
    for (const entry of entries) {
      const icon = await this.#migrateEntry(entry);
      if (icon) icons.push(icon);
    }
    await this.#persist(icons);
    this.#log.info('migrated metadata v1 -> v2', {
      icons: icons.length,
      skipped: entries.length - icons.length,
      backup,
    });
  }

  /** @param {any} e @returns {Promise<Icon | null>} */
  async #migrateEntry(e) {
    const ext = typeof e?.filename === 'string' ? extensionOf(e.filename) : '';
    if (!isSafeFilename(e?.filename) || !FILE_TYPES[ext]) {
      this.#log.warn('migration: skipping entry with unusable filename', { filename: String(e?.filename) });
      return null;
    }
    let size = Number(e.size) || 0;
    let hash = '';
    try {
      const buf = await fs.readFile(path.join(this.iconsDir, e.filename));
      size = buf.length;
      hash = sha256(buf);
    } catch {
      // Keep the entry: the consistency check reports it, and the user can see and delete it.
    }
    return {
      id: isUuid(e.id) ? e.id : randomUUID(),
      name: safeName(e.name, e.filename),
      filename: e.filename,
      tags: safeTags(e.tags),
      size,
      uploadedAt: validDate(e.uploadedAt) ?? new Date().toISOString(),
      contentType: FILE_TYPES[ext].mime,
      sha256: hash,
    };
  }

  // ---------- reads (lock-free: JS is single-threaded and #icons is replaced atomically) ----------

  /** @param {string} [query] */
  list(query = '') {
    return search(this.#index, query);
  }

  /** @param {string} id */
  get(id) {
    return this.#byId.get(id);
  }

  /** @param {string} filename */
  getByFilename(filename) {
    return this.#byFilename.get(filename);
  }

  usage() {
    return { totalSize: this.#totalSize, maxTotalSize: this.#maxTotalBytes, count: this.#icons.length };
  }

  /** @param {string} filename */
  pathFor(filename) {
    // Second line of defence: callers already validated, but nothing here may escape iconsDir.
    if (!isSafeFilename(filename)) throw new AppError(400, 'invalid_body');
    return path.join(this.iconsDir, path.basename(filename));
  }

  // ---------- writes ----------

  /**
   * @param {{ buffer: Buffer, contentType: string, ext: string, name: string, tags: string[], filename?: string, id?: string, uploadedAt?: string }} input
   *   filename/id/uploadedAt are only passed by backup import to keep URLs stable.
   * @returns {Promise<Icon>}
   */
  add(input) {
    return this.#mutex.run(async () => {
      if (this.#totalSize + input.buffer.length > this.#maxTotalBytes) {
        throw new AppError(507, 'quota_exceeded');
      }
      const filename = input.filename ?? (await this.#newFilename(input.name, input.ext));
      /** @type {Icon} */
      const icon = {
        id: input.id ?? randomUUID(),
        name: input.name,
        filename,
        tags: input.tags,
        size: input.buffer.length,
        uploadedAt: input.uploadedAt ?? new Date().toISOString(),
        contentType: input.contentType,
        sha256: sha256(input.buffer),
      };
      const target = this.pathFor(filename);
      await writeFileAtomic(target, input.buffer);
      try {
        await this.#persist([icon, ...this.#icons]);
      } catch (err) {
        await fs.rm(target, { force: true });
        throw err;
      }
      return icon;
    });
  }

  /**
   * @param {string} id
   * @param {{ name?: string, tags?: string[] }} patch
   */
  update(id, patch) {
    return this.#mutex.run(async () => {
      const current = this.#byId.get(id);
      if (!current) throw new AppError(404, 'icon_not_found');
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      await this.#persist(this.#icons.map((i) => (i.id === id ? next : i)));
      return next;
    });
  }

  /** @param {string} id */
  remove(id) {
    return this.#mutex.run(async () => {
      const icon = this.#byId.get(id);
      if (!icon) throw new AppError(404, 'icon_not_found');
      // Metadata first: a crash afterwards leaves an orphan file (harmless, reported at start)
      // rather than an entry pointing nowhere.
      await this.#persist(this.#icons.filter((i) => i.id !== id));
      await fs.rm(this.pathFor(icon.filename), { force: true }).catch((err) => {
        this.#log.warn('could not delete icon file', { filename: icon.filename, err: String(err) });
      });
      return icon;
    });
  }

  /** Wait for pending writes – used on shutdown. */
  idle() {
    return this.#mutex.idle();
  }

  /** @param {string} name @param {string} ext */
  async #newFilename(name, ext) {
    const slug = slugify(name);
    for (;;) {
      const candidate = `${slug}_${randomSuffix()}.${ext}`;
      if (this.#byFilename.has(candidate)) continue;
      const exists = await fs.access(path.join(this.iconsDir, candidate)).then(
        () => true,
        () => false,
      );
      if (!exists) return candidate;
    }
  }

  /** @param {Icon[]} icons */
  async #persist(icons) {
    const doc = { version: METADATA_VERSION, icons };
    await writeFileAtomic(this.metadataPath, `${JSON.stringify(doc, null, 2)}\n`);
    this.#replace(icons);
  }

  /** @param {Icon[]} icons */
  #replace(icons) {
    this.#icons = icons;
    this.#byId = new Map(icons.map((i) => [i.id, i]));
    this.#byFilename = new Map(icons.map((i) => [i.filename, i]));
    this.#totalSize = icons.reduce((sum, i) => sum + i.size, 0);
    this.#index = buildSearchIndex(icons);
  }
}

/**
 * Refuse to start on unreadable metadata. v1 silently treated it as empty and
 * the next upload overwrote every entry – the one way to lose all data.
 * @param {string} raw
 * @param {string} file
 * @returns {{ version: number | undefined, icons: any[] }}
 */
function parseMetadata(raw, file) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new StorageError(
      `${file} is not valid JSON (${String(err)}). Fix or restore it; the app will not overwrite it.`,
    );
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.icons)) {
    throw new StorageError(`${file} has no "icons" array. Fix or restore it; the app will not overwrite it.`);
  }
  if (doc.version !== undefined && doc.version !== METADATA_VERSION) {
    throw new StorageError(`${file} has unknown version ${doc.version}; this app supports ${METADATA_VERSION}.`);
  }
  return doc;
}

/** @param {any} e @returns {Icon} */
function normalizeStored(e) {
  return { ...e, tags: Array.isArray(e.tags) ? e.tags : [] };
}

/** @param {unknown} name @param {string} filename */
function safeName(name, filename) {
  try {
    return normalizeName(name, filename);
  } catch {
    return normalizeName(String(name ?? '').slice(0, LIMITS.NAME_MAX_LENGTH), filename);
  }
}

/** Legacy tags are kept as far as they fit the new limits rather than dropping the icon. @param {unknown} tags */
function safeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const kept = [];
  for (const t of tags) {
    try {
      kept.push(...parseTags([String(t)]));
    } catch {
      /* skip tag that violates limits */
    }
  }
  return [...new Set(kept)].slice(0, LIMITS.TAG_MAX_COUNT);
}

/** @param {unknown} v */
function validDate(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}
