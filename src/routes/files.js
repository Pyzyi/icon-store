import { Router } from 'express';
import { ICON_CACHE_SECONDS, ICON_CSP } from '../constants.js';
import { isSafeFilename } from '../lib/validate.js';

/**
 * Headers for everything under /icons, including 404s. CORP must be
 * cross-origin here – dashboards on other hosts embed these images – while
 * the sandbox CSP keeps a directly opened SVG from running anything.
 * @type {import('express').RequestHandler}
 */
const iconHeaders = (_req, res, next) => {
  res.set({
    'Content-Security-Policy': ICON_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Referrer-Policy': 'no-referrer',
  });
  next();
};

/**
 * Serves only files that have a metadata entry – lookup by exact filename
 * means a crafted path can never reach anything outside ICONS_DIR.
 * @param {{ store: import('../lib/storage.js').Store }} deps
 */
export function filesRouter({ store }) {
  const router = Router();
  router.use(iconHeaders);

  router.get('/:filename', (req, res, next) => {
    const { filename } = req.params;
    const icon = isSafeFilename(filename) ? store.getByFilename(filename) : undefined;
    if (!icon) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.set({
      'Content-Type': icon.contentType,
      'Cache-Control': `public, max-age=${ICON_CACHE_SECONDS}, immutable`,
      'Content-Disposition': 'inline',
    });
    // Content hash = strong ETag that stays valid across restarts and backups.
    if (icon.sha256) res.set('ETag', `"${icon.sha256}"`);
    if (req.fresh) {
      res.status(304).end();
      return;
    }
    res.sendFile(store.pathFor(filename), { etag: false, cacheControl: false, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) {
        res.removeHeader('Cache-Control');
        res.status(404).type('text/plain').send('Not found');
      } else if (err) next(err);
    });
  });

  return router;
}
