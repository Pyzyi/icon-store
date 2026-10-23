import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { fixtures, loggedIn, setup } from './helpers.js';

const URL_RE = /^\/icons\/[a-z0-9-]+_[a-z0-9]{10}\.(png|svg|jpg|jpeg|webp|ico|gif)$/;

describe('upload', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let ctx;
  /** @type {any} */
  let a;
  before(async () => {
    ctx = await setup();
    a = await loggedIn(ctx);
  });
  after(() => ctx.cleanup());

  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'svg']) {
    it(`accepts .${ext} and keeps the v1 URL scheme`, async () => {
      const fixture = ext === 'jpeg' ? fixtures.jpg : fixtures[ext];
      const res = await a
        .post('/api/icons')
        .attach('file', await fixture(), `My Icon.${ext}`)
        .field('name', `Home Assistant ${ext}`)
        .field('tags', 'Smart Home, automation, smart home');
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.match(res.body.url, URL_RE);
      assert.ok(res.body.filename.startsWith(`home-assistant-${ext}_`));
      assert.ok(res.body.filename.endsWith(`.${ext}`));
      assert.deepEqual(res.body.tags, ['smart home', 'automation']);
      assert.equal(res.body.sha256, undefined, 'internal hash is not exposed');
      const file = await a.get(res.body.url);
      assert.equal(file.status, 200);
    });
  }

  it('uses the file name when no name is given', async () => {
    const res = await a.post('/api/icons').attach('file', await fixtures.png(), 'Proxmox VE.png');
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Proxmox VE');
    assert.match(res.body.filename, /^proxmox-ve_[a-z0-9]{10}\.png$/);
  });

  it('strips <script>, handlers, foreignObject and external references from SVG', async () => {
    const res = await a.post('/api/icons').attach('file', fixtures.maliciousSvg(), 'evil.svg');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const stored = await fs.readFile(path.join(ctx.dataDir, 'icons', res.body.filename), 'utf8');
    for (const bad of [
      '<script',
      'onload',
      'onclick',
      'onmouseover',
      'foreignObject',
      'javascript:',
      'evil.example',
      '@import',
    ]) {
      assert.ok(!stored.includes(bad), `stored SVG still contains ${bad}:\n${stored}`);
    }
    assert.match(stored, /<path[^>]+fill="teal"/, 'harmless content survives');
  });

  it('rejects SVG with DOCTYPE / entities (XXE, billion laughs)', async () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>';
    const res = await a.post('/api/icons').attach('file', Buffer.from(xxe), 'xxe.svg');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'svg_unsafe');
  });

  it('rejects malformed SVG', async () => {
    const res = await a
      .post('/api/icons')
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'), 'bad.svg');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'svg_invalid');
  });

  it('adds a missing xmlns instead of rejecting', async () => {
    const res = await a
      .post('/api/icons')
      .attach('file', Buffer.from('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'), 'plain.svg');
    assert.equal(res.status, 201);
  });

  it('rejects a PNG renamed to .svg', async () => {
    const res = await a.post('/api/icons').attach('file', await fixtures.png(), 'fake.svg');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'type_mismatch');
  });

  it('rejects an SVG/HTML renamed to .png', async () => {
    const res = await a
      .post('/api/icons')
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), 'x.png');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'type_mismatch');
  });

  it('rejects HTML disguised as .svg', async () => {
    const res = await a
      .post('/api/icons')
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), 'x.svg');
    assert.equal(res.body.code, 'type_mismatch');
  });

  it('rejects non-UTF-8 "SVG"', async () => {
    const res = await a.post('/api/icons').attach('file', Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe]), 'x.svg');
    assert.equal(res.status, 400);
  });

  it('rejects unsupported extensions', async () => {
    const res = await a.post('/api/icons').attach('file', Buffer.from('<h1>x</h1>'), 'x.html');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'unsupported_type');
  });

  it('rejects requests without file', async () => {
    const res = await a.post('/api/icons').field('name', 'x');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'no_file');
  });

  it('removes metadata and trailing data from raster images', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: 'SECRET-EXIF' } } })
      .toBuffer();
    const polyglot = Buffer.concat([png, Buffer.from('<script>TRAILING-PAYLOAD</script>')]);
    const res = await a.post('/api/icons').attach('file', polyglot, 'meta.png');
    assert.equal(res.status, 201);
    const stored = await fs.readFile(path.join(ctx.dataDir, 'icons', res.body.filename));
    assert.ok(!stored.includes('SECRET-EXIF'));
    assert.ok(!stored.includes('TRAILING-PAYLOAD'));
  });

  it('rejects corrupt raster data with valid magic bytes', async () => {
    const png = await fixtures.png();
    const res = await a.post('/api/icons').attach('file', png.subarray(0, 40), 'cut.png');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_image');
  });

  it('enforces name and tag limits', async () => {
    const png = await fixtures.png();
    const long = await a.post('/api/icons').attach('file', png, 'x.png').field('name', 'n'.repeat(101));
    assert.equal(long.body.code, 'name_too_long');
    const many = await a
      .post('/api/icons')
      .attach('file', png, 'x.png')
      .field('tags', Array.from({ length: 21 }, (_, i) => `t${i}`).join(','));
    assert.equal(many.body.code, 'too_many_tags');
    const longTag = await a.post('/api/icons').attach('file', png, 'x.png').field('tags', 'x'.repeat(33));
    assert.equal(longTag.body.code, 'tag_too_long');
  });

  it('enforces the upload size limit', async () => {
    const s = await setup({ MAX_UPLOAD_MB: '1' });
    try {
      const big = Buffer.concat([await fixtures.png(), Buffer.alloc(1024 * 1024 + 1)]);
      const res = await (await loggedIn(s)).post('/api/icons').attach('file', big, 'big.png');
      assert.equal(res.status, 413);
      assert.equal(res.body.code, 'file_too_large');
    } finally {
      await s.cleanup();
    }
  });

  it('rejects uploads above MAX_TOTAL_SIZE', async () => {
    const s = await setup({ MAX_TOTAL_SIZE_MB: '1' });
    try {
      const agent = await loggedIn(s);
      const noisy = await sharp(
        Buffer.from(Array.from({ length: 400 * 400 * 3 }, () => Math.floor(Math.random() * 256))),
        {
          raw: { width: 400, height: 400, channels: 3 },
        },
      )
        .png()
        .toBuffer();
      let status = 201;
      for (let i = 0; i < 5 && status === 201; i++) {
        status = (await agent.post('/api/icons').attach('file', noisy, 'noise.png')).status;
      }
      assert.equal(status, 507);
    } finally {
      await s.cleanup();
    }
  });

  it('rate-limits uploads', async () => {
    const s = await setup({ UPLOAD_RATE_LIMIT: '2' });
    try {
      const agent = await loggedIn(s);
      const png = await fixtures.png();
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await agent.post('/api/icons').attach('file', png, 'x.png')).status);
      assert.deepEqual(codes, [201, 201, 429]);
    } finally {
      await s.cleanup();
    }
  });

  it('keeps raster bytes unchanged with REENCODE_RASTER=false', async () => {
    const s = await setup({ REENCODE_RASTER: 'false' });
    try {
      const png = await fixtures.png();
      const res = await (await loggedIn(s)).post('/api/icons').attach('file', png, 'x.png');
      const stored = await fs.readFile(path.join(s.dataDir, 'icons', res.body.filename));
      assert.ok(stored.equals(png));
      const bad = await (await loggedIn(s)).post('/api/icons').attach('file', png.subarray(0, 30), 'x.png');
      assert.equal(bad.body.code, 'invalid_image');
    } finally {
      await s.cleanup();
    }
  });

  it('writes an audit entry for uploads', () => {
    assert.ok(ctx.lines.some((l) => l.audit === 'upload' && l.filename));
  });
});
