import fs from 'node:fs/promises';
import path from 'node:path';
import { TMP_PREFIX } from '../constants.js';

/**
 * Compare icons/ with metadata at startup. Only leftovers of interrupted
 * writes (our own temp files) are deleted; everything else is just reported,
 * because guessing wrong would delete user data.
 * @param {import('./storage.js').Store} store
 * @param {import('./log.js').Logger} log
 */
export async function checkConsistency(store, log) {
  const files = await fs.readdir(store.iconsDir, { withFileTypes: true });
  const onDisk = new Set();
  let removedTemp = 0;

  for (const f of files) {
    if (!f.isFile()) continue;
    if (f.name.startsWith(TMP_PREFIX)) {
      await fs.rm(path.join(store.iconsDir, f.name), { force: true });
      removedTemp += 1;
      continue;
    }
    onDisk.add(f.name);
  }
  // metadata.json lives one level up, its temp files too.
  for (const f of await fs.readdir(store.dataDir)) {
    if (f.startsWith(TMP_PREFIX)) {
      await fs.rm(path.join(store.dataDir, f), { force: true });
      removedTemp += 1;
    }
  }

  const orphanFiles = [...onDisk].filter((name) => !store.getByFilename(name));
  const missingFiles = store
    .list()
    .filter((icon) => !onDisk.has(icon.filename))
    .map((icon) => icon.filename);

  for (const name of orphanFiles) log.warn('consistency: file without metadata entry', { filename: name });
  for (const name of missingFiles) log.warn('consistency: metadata entry without file', { filename: name });
  log.info('consistency check finished', {
    icons: store.usage().count,
    orphanFiles: orphanFiles.length,
    missingFiles: missingFiles.length,
    removedTempFiles: removedTemp,
  });
  return { orphanFiles, missingFiles, removedTemp };
}
