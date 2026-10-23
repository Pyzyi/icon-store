import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import multer from 'multer';
import { TMP_PREFIX } from '../constants.js';
import { createExport, importBackup } from '../lib/backup.js';
import { AppError } from '../lib/errors.js';

/**
 * @param {import('../app.js').AppDeps & { uploadGuards: import('express').RequestHandler[] }} deps
 */
export function backupRouter({ config, store, audit, auth, uploadGuards, log }) {
  const router = Router();
  // A backup can be far larger than the container's RAM, so it goes to disk in
  // DATA_DIR (not /tmp, which is a RAM-backed tmpfs in the compose setup).
  const upload = multer({
    storage: multer.diskStorage({
      destination: store.dataDir,
      filename: (_req, _file, cb) => cb(null, `${TMP_PREFIX}import-${randomBytes(8).toString('hex')}.zip`),
    }),
    limits: { fileSize: config.maxImportBytes, files: 1, fields: 0, parts: 1 },
  }).single('file');

  router.get('/export', auth.requireAuth, async (req, res) => {
    const date = new Date().toISOString().slice(0, 10);
    const stream = await createExport(store);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="icon-store-backup-${date}.zip"`);
    audit('export', { ip: req.ip, icons: store.usage().count });
    await pipeline(stream, res).catch((err) => log.warn('export aborted', { err: String(err) }));
  });

  router.post('/import', ...uploadGuards, upload, async (req, res) => {
    const file = req.file;
    if (!file) throw new AppError(400, 'no_file');
    let result;
    try {
      result = await importBackup(file.path, {
        store,
        maxUploadBytes: config.maxUploadBytes,
        reencodeRaster: config.reencodeRaster,
      });
    } finally {
      await fs.rm(file.path, { force: true });
    }
    audit('import', { ip: req.ip, imported: result.imported, skipped: result.skipped, failed: result.failed.length });
    res.json(result);
  });

  return router;
}
