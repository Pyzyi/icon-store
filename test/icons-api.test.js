import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixtures, loggedIn, setup } from './helpers.js';

describe('icons API', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let ctx;
  /** @type {any} */
  let a;
  /** @type {Record<string, any>} */
  const icons = {};
  before(async () => {
    ctx = await setup();
    a = await loggedIn(ctx);
    const png = await fixtures.png();
    for (const [name, tags] of [
      ['Proxmox', 'virtualization, hypervisor'],
      ['Home Assistant', 'smart-home'],
      ['Jellyfin', 'media'],
    ]) {
      icons[name] = (
        await a.post('/api/icons').attach('file', png, 'x.png').field('name', name).field('tags', tags)
      ).body;
    }
  });
  after(() => ctx.cleanup());

  describe('search', () => {
    /** @param {string} q */
    const names = async (q) =>
      (await a.get(`/api/icons?q=${encodeURIComponent(q)}`)).body.icons.map((i) => i.name).sort();

    it('lists everything without a query, newest first', async () => {
      const res = await a.get('/api/icons');
      assert.deepEqual(
        res.body.icons.map((i) => i.name),
        ['Jellyfin', 'Home Assistant', 'Proxmox'],
      );
      assert.equal(res.body.total, 3);
      assert.equal(res.body.usage.count, 3);
    });
    it('matches names case-insensitively', async () => assert.deepEqual(await names('PROX'), ['Proxmox']));
    it('matches filenames', async () => assert.deepEqual(await names('home-assistant_'), ['Home Assistant']));
    it('matches tags', async () => assert.deepEqual(await names('hyper'), ['Proxmox']));
    it('returns nothing for unknown terms', async () => assert.deepEqual(await names('zzz'), []));
  });

  describe('edit', () => {
    it('changes name and tags but keeps the URL', async () => {
      const id = icons.Jellyfin.id;
      const res = await a.patch(`/api/icons/${id}`).send({ name: 'Jellyfin Media', tags: 'Media, streaming' });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Jellyfin Media');
      assert.deepEqual(res.body.tags, ['media', 'streaming']);
      assert.equal(res.body.filename, icons.Jellyfin.filename);
      assert.ok(res.body.updatedAt);
      assert.ok(ctx.lines.some((l) => l.audit === 'update' && l.id === id));
    });
    it('accepts tags as array and keeps the name when empty', async () => {
      const res = await a.patch(`/api/icons/${icons.Proxmox.id}`).send({ name: '  ', tags: ['pve'] });
      assert.equal(res.body.name, 'Proxmox');
      assert.deepEqual(res.body.tags, ['pve']);
    });
    it('validates input', async () => {
      assert.equal(
        (await a.patch(`/api/icons/${icons.Proxmox.id}`).send({ name: 'x'.repeat(101) })).body.code,
        'name_too_long',
      );
      assert.equal((await a.patch(`/api/icons/${icons.Proxmox.id}`).send({ tags: 5 })).body.code, 'invalid_body');
      assert.equal((await a.patch(`/api/icons/${icons.Proxmox.id}`).send([1])).body.code, 'invalid_body');
      const notJson = await a.patch(`/api/icons/${icons.Proxmox.id}`).type('text').send('name=x');
      assert.equal(notJson.body.code, 'invalid_body');
      const broken = await a.patch(`/api/icons/${icons.Proxmox.id}`).type('json').send('{"name":');
      assert.equal(broken.body.code, 'invalid_body');
      const huge = await a.patch(`/api/icons/${icons.Proxmox.id}`).send({ name: 'x'.repeat(20_000) });
      assert.equal(huge.status, 413);
    });
    it('returns 404/400 for unknown or malformed ids', async () => {
      assert.equal((await a.patch('/api/icons/00000000-0000-4000-8000-000000000000').send({ name: 'x' })).status, 404);
      assert.equal((await a.patch('/api/icons/not-a-uuid').send({ name: 'x' })).status, 400);
    });
  });

  describe('delete', () => {
    it('removes entry and file', async () => {
      const icon = icons['Home Assistant'];
      const file = path.join(ctx.dataDir, 'icons', icon.filename);
      await fs.access(file);
      const res = await a.delete(`/api/icons/${icon.id}`);
      assert.equal(res.status, 200);
      await assert.rejects(fs.access(file));
      assert.equal((await a.get(icon.url)).status, 404);
      assert.equal((await a.delete(`/api/icons/${icon.id}`)).status, 404);
      assert.ok(ctx.lines.some((l) => l.audit === 'delete' && l.id === icon.id));
    });

    it('cannot be abused for path traversal', async () => {
      const victim = path.join(ctx.dataDir, 'metadata.json');
      for (const id of [
        '..%2Fmetadata.json',
        '..%2F..%2Fetc%2Fpasswd',
        '%2e%2e%2fmetadata.json',
        '....//metadata.json',
      ]) {
        const res = await a.delete(`/api/icons/${id}`);
        assert.ok([400, 404].includes(res.status), `${id} -> ${res.status}`);
      }
      await fs.access(victim);
    });

    it('never deletes outside ICONS_DIR even with tampered metadata', async () => {
      const outside = path.join(ctx.dataDir, 'secret.png');
      await fs.writeFile(outside, 'keep me');
      assert.throws(() => ctx.store.pathFor('../secret.png'));
      assert.throws(() => ctx.store.pathFor('/etc/passwd'));
      await fs.access(outside);
    });
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const res = await a.get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'not_found');
  });

  it('returns 503 when all upload slots are busy', async () => {
    const s = await setup({ MAX_CONCURRENT_UPLOADS: '1' });
    try {
      const agent = await loggedIn(s);
      const png = await fixtures.png();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => agent.post('/api/icons').attach('file', png, 'x.png')),
      );
      const codes = results.map((r) => r.status);
      assert.ok(codes.includes(201));
      assert.ok(
        codes.every((c) => c === 201 || c === 503),
        codes.join(','),
      );
    } finally {
      await s.cleanup();
    }
  });
});
