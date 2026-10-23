import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { fixtures, loggedIn, setup, tempDir } from './helpers.js';

/** @param {any} res */
function binaryParser(res, cb) {
  /** @type {Buffer[]} */
  const chunks = [];
  res.on('data', (/** @type {Buffer} */ c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

/** @param {Record<string, Buffer | string>} files */
async function makeZip(files) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const c of zip.outputStream) chunks.push(c);
  return Buffer.concat(chunks);
}

/** @param {Buffer} buf @returns {Promise<string[]>} */
function zipNames(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const names = [];
      zip.on('entry', (e) => {
        names.push(e.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}

describe('backup export/import', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let src;
  /** @type {Buffer} */
  let zip;
  before(async () => {
    src = await setup();
    const a = await loggedIn(src);
    await a
      .post('/api/icons')
      .attach('file', await fixtures.png(), 'a.png')
      .field('name', 'Alpha')
      .field('tags', 'one, two');
    await a.post('/api/icons').attach('file', fixtures.svg(), 'b.svg').field('name', 'Beta');
    await a
      .post('/api/icons')
      .attach('file', await fixtures.gif(), 'c.gif')
      .field('name', 'Gamma');
    // One entry whose file vanished must not break the export.
    const gone = src.store.list()[0];
    await fs.rm(path.join(src.dataDir, 'icons', gone.filename));
    const res = await a.get('/api/export').buffer(true).parse(binaryParser);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(res.headers['content-disposition'], /attachment; filename="icon-store-backup-\d{4}-\d{2}-\d{2}\.zip"/);
    zip = res.body;
  });
  after(() => src.cleanup());

  it('exports metadata and all existing files', async () => {
    const names = await zipNames(zip);
    assert.ok(names.includes('metadata.json'));
    assert.equal(names.filter((n) => n.startsWith('icons/')).length, 2);
  });

  it('restores icons with identical filenames, names and tags', async () => {
    const dst = await setup();
    try {
      const a = await loggedIn(dst);
      const res = await a.post('/api/import').attach('file', zip, 'backup.zip');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { imported: 2, skipped: 0, failed: [] });
      const originals = src.store.list().filter((i) => i.filename !== src.store.list()[0].filename);
      for (const o of originals) {
        const copy = dst.store.getByFilename(o.filename);
        assert.ok(copy, `${o.filename} restored`);
        assert.equal(copy.name, o.name);
        assert.deepEqual(copy.tags, o.tags);
        assert.equal(copy.id, o.id);
        assert.equal((await a.get(`/icons/${o.filename}`)).status, 200);
      }
      const again = await a.post('/api/import').attach('file', zip, 'backup.zip');
      assert.deepEqual(
        again.body,
        { imported: 0, skipped: 2, failed: [] },
        'existing icons are skipped, not overwritten',
      );
      assert.ok(dst.lines.some((l) => l.audit === 'import'));
      assert.deepEqual(
        (await fs.readdir(dst.dataDir)).filter((f) => f.startsWith('.tmp-')),
        [],
        'uploaded zip removed',
      );
    } finally {
      await dst.cleanup();
    }
  });

  it('ignores unsafe entry names and sanitises imported SVGs', async () => {
    const dst = await setup();
    try {
      const evil = await makeZip({
        'metadata.json': JSON.stringify({
          icons: [
            { name: 'Evil', filename: 'evil_aaaaaaaaaa.svg', tags: ['x'] },
            { name: 'Escape', filename: '../escape.png', tags: [] },
            { name: 'NoFile', filename: 'nofile_aaaaaaaaaa.png', tags: [] },
            { name: 'Fake', filename: 'fake_aaaaaaaaaa.png', tags: [] },
          ],
        }),
        'icons/evil_aaaaaaaaaa.svg': fixtures.maliciousSvg(),
        'icons/fake_aaaaaaaaaa.png': '<html>not a png</html>',
        'icons/sub/nested_aaaaaaaaaa.png': await fixtures.png(),
      });
      const res = await (await loggedIn(dst)).post('/api/import').attach('file', evil, 'evil.zip');
      assert.equal(res.status, 200);
      assert.equal(res.body.imported, 1);
      assert.deepEqual(res.body.failed.map((f) => f.code).sort(), ['invalid_zip', 'invalid_zip', 'type_mismatch']);
      const stored = await fs.readFile(path.join(dst.dataDir, 'icons', 'evil_aaaaaaaaaa.svg'), 'utf8');
      assert.ok(!stored.includes('<script'));
      await assert.rejects(fs.access(path.join(dst.dataDir, '..', 'escape.png')));
    } finally {
      await dst.cleanup();
    }
  });

  it('rejects archives with path traversal entry names as a whole', async () => {
    const dst = await setup();
    try {
      // yazl refuses to write "../", so patch the name bytes afterwards (same length).
      const clean = await makeZip({
        'metadata.json': JSON.stringify({ icons: [] }),
        'aa/escape.png': await fixtures.png(),
      });
      const evil = Buffer.from(clean.toString('latin1').replaceAll('aa/escape.png', '../escape.png'), 'latin1');
      const res = await (await loggedIn(dst)).post('/api/import').attach('file', evil, 'evil.zip');
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'invalid_zip');
      await assert.rejects(fs.access(path.join(dst.dataDir, '..', 'escape.png')));
    } finally {
      await dst.cleanup();
    }
  });

  it('rejects files that are not a backup', async () => {
    const dst = await setup();
    try {
      const a = await loggedIn(dst);
      const notZip = await a.post('/api/import').attach('file', Buffer.from('hello'), 'x.zip');
      assert.equal(notZip.body.code, 'invalid_zip');
      const noMeta = await a.post('/api/import').attach('file', await makeZip({ 'readme.txt': 'x' }), 'x.zip');
      assert.equal(noMeta.body.code, 'invalid_zip');
      const badMeta = await a.post('/api/import').attach('file', await makeZip({ 'metadata.json': '{nope' }), 'x.zip');
      assert.equal(badMeta.body.code, 'invalid_zip');
      const none = await a.post('/api/import');
      assert.equal(none.body.code, 'no_file');
    } finally {
      await dst.cleanup();
    }
  });

  it('enforces per-file limits inside the backup', async () => {
    const dst = await setup({ MAX_UPLOAD_MB: '1' });
    try {
      const big = Buffer.concat([await fixtures.png(), Buffer.alloc(2 * 1024 * 1024)]);
      const z = await makeZip({
        'metadata.json': JSON.stringify({ icons: [{ name: 'Big', filename: 'big_aaaaaaaaaa.png' }] }),
        'icons/big_aaaaaaaaaa.png': big,
      });
      const res = await (await loggedIn(dst)).post('/api/import').attach('file', z, 'x.zip');
      assert.deepEqual(res.body.failed, [{ filename: 'big_aaaaaaaaaa.png', code: 'file_too_large' }]);
    } finally {
      await dst.cleanup();
    }
  });

  it('works for a hand-made zip of a v1 data folder', async () => {
    const dir = await tempDir();
    const dst = await setup({}, { dataDir: dir });
    try {
      const png = await fixtures.png();
      const z = await makeZip({
        'metadata.json': JSON.stringify({
          icons: [
            {
              id: 'old',
              name: 'Old',
              filename: 'old_abcdefghij.png',
              tags: ['legacy'],
              uploadedAt: '2023-01-01T00:00:00.000Z',
            },
          ],
        }),
        'icons/old_abcdefghij.png': png,
      });
      const res = await (await loggedIn(dst)).post('/api/import').attach('file', z, 'v1.zip');
      assert.equal(res.body.imported, 1);
      const icon = dst.store.getByFilename('old_abcdefghij.png');
      assert.equal(icon?.uploadedAt, '2023-01-01T00:00:00.000Z');
      assert.deepEqual(icon?.tags, ['legacy']);
    } finally {
      await dst.cleanup();
    }
  });
});
