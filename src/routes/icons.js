import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { FILE_TYPES, LIMITS } from '../constants.js';
import { AppError } from '../lib/errors.js';
import { processIcon } from '../lib/pipeline.js';
import { assertUuid, extensionOf, normalizeName, parseTags } from '../lib/validate.js';

/** @param {import('../lib/storage.js').Icon} icon */
export function toPublic(icon) {
  const { sha256: _hash, ...rest } = icon;
  return { ...rest, url: `/icons/${icon.filename}` };
}

/**
 * @param {import('../app.js').AppDeps & { uploadGuards: import('express').RequestHandler[], browseGuard: import('express').RequestHandler }} deps
 */
export function iconsRouter({ config, store, audit, auth, uploadGuards, browseGuard }) {
  const router = Router();
  // Memory storage is bounded: one file per request, fileSize limit, and the
  // upload semaphore in uploadGuards caps how many requests buffer at once.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 4,
      parts: 5,
      fieldSize: LIMITS.FORM_FIELD_BYTES,
    },
    defParamCharset: 'utf8',
  }).single('file');

  router.get('/icons', browseGuard, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const icons = store.list(q).map(toPublic);
    res.json({ icons, total: icons.length, usage: store.usage() });
  });

  router.post('/icons', ...uploadGuards, upload, async (req, res) => {
    const file = req.file;
    if (!file) throw new AppError(400, 'no_file');
    const ext = extensionOf(file.originalname);
    if (!FILE_TYPES[ext]) throw new AppError(400, 'unsupported_type', { ext });

    const base = path.basename(file.originalname, path.extname(file.originalname));
    const name = normalizeName(req.body?.name, base);
    const tags = parseTags(req.body?.tags ?? '');
    const processed = await processIcon(file.buffer, ext, config);
    const icon = await store.add({ ...processed, ext, name, tags });

    audit('upload', { ip: req.ip, id: icon.id, filename: icon.filename, size: icon.size });
    res.status(201).json(toPublic(icon));
  });

  router.patch('/icons/:id', auth.requireAuth, async (req, res) => {
    const id = assertUuid(req.params.id);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_body');
    const current = store.get(id);
    if (!current) throw new AppError(404, 'icon_not_found');

    /** @type {{ name?: string, tags?: string[] }} */
    const patch = {};
    // Like v1, an empty name keeps the current one instead of failing.
    if (typeof body.name === 'string') patch.name = normalizeName(body.name, current.name);
    if (body.tags !== undefined) patch.tags = parseTags(body.tags);

    const icon = await store.update(id, patch);
    audit('update', { ip: req.ip, id, fields: Object.keys(patch) });
    res.json(toPublic(icon));
  });

  router.delete('/icons/:id', auth.requireAuth, async (req, res) => {
    const id = assertUuid(req.params.id);
    const icon = await store.remove(id);
    audit('delete', { ip: req.ip, id, filename: icon.filename });
    res.json({ ok: true });
  });

  return router;
}
