import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { fixtures, loggedIn, setup } from './helpers.js';

describe('icon delivery', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let ctx;
  /** @type {any} */
  let svg;
  /** @type {any} */
  let png;
  before(async () => {
    ctx = await setup();
    const a = await loggedIn(ctx);
    svg = (await a.post('/api/icons').attach('file', fixtures.svg(), 'logo.svg')).body;
    png = (await a.post('/api/icons').attach('file', await fixtures.png(), 'logo.png')).body;
  });
  after(() => ctx.cleanup());

  it('serves icons publicly with strict, cross-origin-friendly headers', async () => {
    const res = await request(ctx.app).get(svg.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml');
    assert.equal(
      res.headers['content-security-policy'],
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    );
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(res.headers.etag, /^"[0-9a-f]{64}"$/);
  });

  it('answers If-None-Match with 304', async () => {
    const first = await request(ctx.app).get(png.url);
    assert.equal(first.headers['content-type'], 'image/png');
    const second = await request(ctx.app).get(png.url).set('If-None-Match', first.headers.etag);
    assert.equal(second.status, 304);
  });

  it('only serves files with a metadata entry', async () => {
    await fs.writeFile(path.join(ctx.dataDir, 'icons', 'stray_abcdefghij.png'), await fixtures.png());
    assert.equal((await request(ctx.app).get('/icons/stray_abcdefghij.png')).status, 404);
  });

  it('blocks path traversal on delivery', async () => {
    for (const p of [
      '/icons/..%2Fmetadata.json',
      '/icons/%2e%2e%2fmetadata.json',
      '/icons/../metadata.json',
      '/icons/.hidden.png',
    ]) {
      const res = await request(ctx.app).get(p);
      assert.ok([404, 400].includes(res.status), `${p} -> ${res.status}`);
      assert.ok(!res.text.includes('"icons"'), `${p} leaked metadata`);
    }
  });

  it('returns 404 if the file vanished from disk', async () => {
    await fs.rm(path.join(ctx.dataDir, 'icons', png.filename));
    const res = await request(ctx.app).get(png.url);
    assert.equal(res.status, 404);
    assert.equal(res.headers['cache-control'], undefined);
  });

  it('serves the UI with a strict CSP and same-origin CORP', async () => {
    const res = await request(ctx.app).get('/');
    assert.equal(res.status, 200);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|googleapis/);
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.doesNotMatch(res.text, /<script>(?!<\/script>)/, 'no inline script');
    assert.doesNotMatch(res.text, /fonts\.googleapis/);
  });

  it('has a public health endpoint', async () => {
    const res = await request(ctx.app).get('/api/health');
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('answers unknown pages with 404', async () => {
    assert.equal((await request(ctx.app).get('/nope.php')).status, 404);
  });
});
