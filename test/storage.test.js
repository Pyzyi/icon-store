import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import request from 'supertest';
import { checkConsistency } from '../src/lib/consistency.js';
import { Mutex, Semaphore } from '../src/lib/mutex.js';
import { sha256, StorageError, Store, writeFileAtomic } from '../src/lib/storage.js';
import { fixtures, loggedIn, memoryLogger, setup, tempDir, writeV1Data } from './helpers.js';

/** @type {(() => Promise<void>)[]} */
const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
});

/** @param {string} dataDir */
async function newStore(dataDir, maxTotalBytes = 1024 ** 3) {
  const { log, lines } = memoryLogger();
  const store = new Store({ dataDir, maxTotalBytes, log });
  await store.init();
  return { store, lines };
}

describe('storage', () => {
  it('loses no entries under parallel uploads', async () => {
    const ctx = await setup({ MAX_CONCURRENT_UPLOADS: '64', UPLOAD_RATE_LIMIT: '1000' });
    cleanups.push(ctx.cleanup);
    const a = await loggedIn(ctx);
    const png = await fixtures.png();
    const N = 40;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => a.post('/api/icons').attach('file', png, `p${i}.png`).field('name', `p${i}`)),
    );
    assert.ok(results.every((r) => r.status === 201));
    const onDisk = JSON.parse(await fs.readFile(path.join(ctx.dataDir, 'metadata.json'), 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.equal(onDisk.icons.length, N);
    assert.equal(new Set(onDisk.icons.map((i) => i.filename)).size, N);
    const files = await fs.readdir(path.join(ctx.dataDir, 'icons'));
    assert.equal(files.length, N, 'no temp files left behind');
  });

  it('serialises parallel updates and deletes', async () => {
    const dir = await tempDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const { store } = await newStore(dir);
    const png = await fixtures.png();
    const icons = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.add({ buffer: png, contentType: 'image/png', ext: 'png', name: `n${i}`, tags: [] }),
      ),
    );
    await Promise.all([
      ...icons.slice(0, 5).map((i) => store.remove(i.id)),
      ...icons.slice(5).map((i) => store.update(i.id, { tags: ['x'] })),
    ]);
    const reloaded = (await newStore(dir)).store.list();
    assert.equal(reloaded.length, 5);
    assert.ok(reloaded.every((i) => i.tags[0] === 'x'));
  });

  it('migrates v1 data without changing filenames and keeps a backup', async () => {
    const dir = await tempDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const png = await fixtures.png();
    const svg = fixtures.svg();
    const v1 = [
      {
        id: 'a1b2c3d4-0000-4000-8000-000000000001',
        name: 'Proxmox',
        filename: 'proxmox_k3j9x0abcd.png',
        tags: ['virtualization'],
        size: 1,
        uploadedAt: '2024-05-01T10:00:00.000Z',
      },
      {
        id: 'a1b2c3d4-0000-4000-8000-000000000002',
        name: 'Logo',
        filename: 'logo_0123456789.svg',
        tags: [],
        size: 1,
        uploadedAt: '2024-05-02T10:00:00.000Z',
      },
      {
        id: 'legacy-not-uuid',
        name: 'Missing',
        filename: 'missing_aaaaaaaaaa.jpeg',
        tags: 'oops',
        size: 5,
        uploadedAt: 'bad',
      },
      { id: 'x', name: 'Evil', filename: '../../etc/passwd', tags: [] },
    ];
    await writeV1Data(dir, v1, { 'proxmox_k3j9x0abcd.png': png, 'logo_0123456789.svg': svg });
    const ctx = await setup({}, { dataDir: dir });
    cleanups.push(ctx.cleanup);

    const backup = JSON.parse(await fs.readFile(path.join(dir, 'metadata.v1.bak.json'), 'utf8'));
    assert.deepEqual(backup, { icons: v1 });

    const icons = ctx.store.list();
    assert.equal(icons.length, 3, 'unsafe filename dropped, missing file kept');
    const prox = ctx.store.getByFilename('proxmox_k3j9x0abcd.png');
    assert.equal(prox?.id, v1[0].id);
    assert.equal(prox?.uploadedAt, v1[0].uploadedAt);
    assert.equal(prox?.sha256, sha256(png));
    assert.equal(prox?.size, png.length);
    const missing = ctx.store.getByFilename('missing_aaaaaaaaaa.jpeg');
    assert.equal(missing?.contentType, 'image/jpeg');
    assert.match(String(missing?.id), /^[0-9a-f-]{36}$/);

    // Old dashboard links keep working, byte for byte.
    const res = await request(ctx.app).get('/icons/proxmox_k3j9x0abcd.png');
    assert.equal(res.status, 200);
    assert.ok(Buffer.compare(res.body, png) === 0);
    const svgRes = await request(ctx.app).get('/icons/logo_0123456789.svg');
    assert.equal(svgRes.headers['content-type'], 'image/svg+xml');

    // Second start: no second migration, backup untouched.
    const again = await newStore(dir);
    assert.equal(again.store.list().length, 3);
  });

  it('refuses to start on corrupt metadata instead of overwriting it', async () => {
    const dir = await tempDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, 'icons'), { recursive: true });
    for (const content of ['{ "icons": [ broken', '{"foo": 1}', '{"version": 99, "icons": []}']) {
      await fs.writeFile(path.join(dir, 'metadata.json'), content);
      await assert.rejects(newStore(dir), StorageError);
      assert.equal(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'), content);
    }
  });

  it('reports orphans and missing files and removes temp leftovers at startup', async () => {
    const dir = await tempDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const { store } = await newStore(dir);
    const png = await fixtures.png();
    const icon = await store.add({ buffer: png, contentType: 'image/png', ext: 'png', name: 'gone', tags: [] });
    await fs.rm(path.join(dir, 'icons', icon.filename));
    await fs.writeFile(path.join(dir, 'icons', 'orphan_aaaaaaaaaa.png'), png);
    await fs.writeFile(path.join(dir, 'icons', '.tmp-deadbeef'), 'partial');
    await fs.writeFile(path.join(dir, '.tmp-cafebabe'), 'partial');
    await fs.mkdir(path.join(dir, 'icons', 'subdir'));

    const { log, lines } = memoryLogger();
    const report = await checkConsistency(store, log);
    assert.deepEqual(report.orphanFiles, ['orphan_aaaaaaaaaa.png']);
    assert.deepEqual(report.missingFiles, [icon.filename]);
    assert.equal(report.removedTemp, 2);
    assert.ok(lines.some((l) => l.msg.includes('without metadata')));
    await assert.rejects(fs.access(path.join(dir, 'icons', '.tmp-deadbeef')));
    await fs.access(path.join(dir, 'icons', 'orphan_aaaaaaaaaa.png'));
  });

  it('rolls back the file when metadata cannot be written', async () => {
    const dir = await tempDir();
    cleanups.push(async () => {
      await fs.chmod(dir, 0o755).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    });
    const { store } = await newStore(dir);
    // Replace metadata.json with a directory so the atomic rename fails.
    await fs.rm(path.join(dir, 'metadata.json'));
    await fs.mkdir(path.join(dir, 'metadata.json'));
    await fs.writeFile(path.join(dir, 'metadata.json', 'x'), '');
    await assert.rejects(
      store.add({ buffer: await fixtures.png(), contentType: 'image/png', ext: 'png', name: 'x', tags: [] }),
    );
    const files = await fs.readdir(path.join(dir, 'icons'));
    assert.deepEqual(files, [], 'icon file removed again');
    assert.equal(store.list().length, 0, 'memory unchanged');
    const temps = (await fs.readdir(dir)).filter((f) => f.startsWith('.tmp-'));
    assert.deepEqual(temps, []);
  });

  it('writes atomically', async () => {
    const dir = await tempDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'f.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(target, JSON.stringify({ i }))));
    assert.doesNotThrow(() => JSON.parse(String(fs.readFile(target, 'utf8') && '{}')));
    JSON.parse(await fs.readFile(target, 'utf8'));
    assert.deepEqual(await fs.readdir(dir), ['f.json']);
  });

  it('logs and continues when an icon file cannot be deleted', async () => {
    const dir = await tempDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const { store, lines } = await newStore(dir);
    const icon = await store.add({
      buffer: await fixtures.png(),
      contentType: 'image/png',
      ext: 'png',
      name: 'x',
      tags: [],
    });
    const file = path.join(dir, 'icons', icon.filename);
    await fs.rm(file);
    await fs.mkdir(file);
    await fs.writeFile(path.join(file, 'child'), '');
    await store.remove(icon.id);
    assert.equal(store.list().length, 0);
    assert.ok(lines.some((l) => l.msg === 'could not delete icon file'));
  });
});

describe('mutex/semaphore', () => {
  it('runs critical sections one after another and survives rejections', async () => {
    const m = new Mutex();
    const order = [];
    const slow = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const failing = m.run(async () => {
      throw new Error('boom');
    });
    const fast = m.run(async () => order.push(2));
    await slow;
    await assert.rejects(failing, /boom/);
    await fast;
    await m.idle();
    assert.deepEqual(order, [1, 2]);
  });

  it('limits concurrent slots', () => {
    const s = new Semaphore(1);
    assert.equal(s.tryAcquire(), true);
    assert.equal(s.tryAcquire(), false);
    s.release();
    assert.equal(s.tryAcquire(), true);
  });
});
