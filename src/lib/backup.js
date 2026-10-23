import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { FILE_TYPES, ICONS_SUBDIR, LIMITS, METADATA_FILE, METADATA_VERSION } from '../constants.js';
import { AppError } from './errors.js';
import { processIcon } from './pipeline.js';
import { extensionOf, isSafeFilename, isUuid, normalizeName, parseTags } from './validate.js';

/** Metadata for tens of thousands of icons stays well below this. */
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const ICON_PREFIX = `${ICONS_SUBDIR}/`;

/**
 * Stream a ZIP of metadata.json + icons/*. Files are read from disk one by
 * one, so memory use does not grow with the size of the collection.
 * @param {import('./storage.js').Store} store
 * @returns {Promise<NodeJS.ReadableStream>}
 */
export async function createExport(store) {
  const icons = store.list();
  const zip = new yazl.ZipFile();
  const present = [];
  for (const icon of icons) {
    const file = store.pathFor(icon.filename);
    const exists = await fs.access(file).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    present.push(icon);
    zip.addFile(file, `${ICON_PREFIX}${icon.filename}`, { compress: false });
  }
  zip.addBuffer(Buffer.from(JSON.stringify({ version: METADATA_VERSION, icons: present }, null, 2)), METADATA_FILE);
  zip.end();
  return zip.outputStream;
}

/**
 * @typedef {{ imported: number, skipped: number, failed: { filename: string, code: string }[] }} ImportResult
 */

/**
 * Restore a backup made by createExport (or a ZIP of a v1 data folder).
 * Every file goes through the same validation as a browser upload, entries
 * whose filename already exists are skipped, nothing is overwritten.
 * @param {string} zipPath
 * @param {{ store: import('./storage.js').Store, maxUploadBytes: number, reencodeRaster: boolean }} deps
 * @returns {Promise<ImportResult>}
 */
export async function importBackup(zipPath, deps) {
  const zip = await openZip(zipPath);
  try {
    const entries = await readEntries(zip);
    const metaEntry = entries.get(METADATA_FILE);
    if (!metaEntry || metaEntry.uncompressedSize > MAX_METADATA_BYTES) throw new AppError(400, 'invalid_zip');
    const doc = parseJson(await readEntry(zip, metaEntry, MAX_METADATA_BYTES));
    /** @type {ImportResult} */
    const result = { imported: 0, skipped: 0, failed: [] };
    for (const raw of doc.icons) {
      await importOne(zip, entries, raw, deps, result);
    }
    return result;
  } finally {
    zip.close();
  }
}

/**
 * @param {yauzl.ZipFile} zip
 * @param {Map<string, yauzl.Entry>} entries
 * @param {any} raw
 * @param {{ store: import('./storage.js').Store, maxUploadBytes: number, reencodeRaster: boolean }} deps
 * @param {ImportResult} result
 */
async function importOne(zip, entries, raw, deps, result) {
  const filename = raw?.filename;
  if (!isSafeFilename(filename) || !FILE_TYPES[extensionOf(filename)]) {
    result.failed.push({ filename: String(filename).slice(0, LIMITS.NAME_MAX_LENGTH), code: 'invalid_zip' });
    return;
  }
  if (deps.store.getByFilename(filename)) {
    result.skipped += 1;
    return;
  }
  const entry = entries.get(`${ICON_PREFIX}${filename}`);
  try {
    if (!entry) throw new AppError(400, 'invalid_zip');
    if (entry.uncompressedSize > deps.maxUploadBytes) throw new AppError(413, 'file_too_large');
    const ext = extensionOf(filename);
    const processed = await processIcon(await readEntry(zip, entry, deps.maxUploadBytes), ext, deps);
    await deps.store.add({
      ...processed,
      ext,
      filename,
      name: normalizeName(raw.name, filename),
      tags: parseTags(Array.isArray(raw.tags) ? raw.tags : []),
      id: isUuid(raw.id) && !deps.store.get(raw.id) ? raw.id : randomUUID(),
      uploadedAt:
        typeof raw.uploadedAt === 'string' && !Number.isNaN(Date.parse(raw.uploadedAt)) ? raw.uploadedAt : undefined,
    });
    result.imported += 1;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    result.failed.push({ filename, code: err.code });
  }
}

/** @param {Buffer} buf @returns {{ icons: any[] }} */
function parseJson(buf) {
  try {
    const doc = JSON.parse(buf.toString('utf8'));
    if (doc && Array.isArray(doc.icons)) return doc;
  } catch {
    /* fall through */
  }
  throw new AppError(400, 'invalid_zip');
}

/** @param {string} file @returns {Promise<yauzl.ZipFile>} */
function openZip(file) {
  return new Promise((resolve, reject) => {
    // strictFileNames rejects backslashes; validateEntrySizes catches headers that lie about size (zip bombs).
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (err, zip) => (err || !zip ? reject(new AppError(400, 'invalid_zip')) : resolve(zip)),
    );
  });
}

/**
 * Only the two kinds of names we create are collected; anything else
 * (absolute paths, "..", nested dirs) is ignored rather than extracted.
 * @param {yauzl.ZipFile} zip
 * @returns {Promise<Map<string, yauzl.Entry>>}
 */
function readEntries(zip) {
  return new Promise((resolve, reject) => {
    /** @type {Map<string, yauzl.Entry>} */
    const entries = new Map();
    let count = 0;
    zip.on('entry', (/** @type {yauzl.Entry} */ entry) => {
      count += 1;
      if (count > LIMITS.ZIP_MAX_ENTRIES) {
        reject(new AppError(400, 'invalid_zip'));
        return;
      }
      const name = entry.fileName;
      const isIcon = name.startsWith(ICON_PREFIX) && isSafeFilename(name.slice(ICON_PREFIX.length));
      if (name === METADATA_FILE || isIcon) entries.set(name, entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', () => reject(new AppError(400, 'invalid_zip')));
    zip.readEntry();
  });
}

/**
 * @param {yauzl.ZipFile} zip
 * @param {yauzl.Entry} entry
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readEntry(zip, entry, limit) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(new AppError(400, 'invalid_zip'));
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      stream.on('data', (/** @type {Buffer} */ chunk) => {
        size += chunk.length;
        if (size > limit) {
          stream.destroy();
          reject(new AppError(413, 'file_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', () => reject(new AppError(400, 'invalid_zip')));
    });
  });
}
