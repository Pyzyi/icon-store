import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, errorHandler, fromLibraryError } from '../src/lib/errors.js';
import { createAudit, createLogger } from '../src/lib/log.js';
import { isSafeFilename, normalizeName, parseTags, slugify } from '../src/lib/validate.js';
import { tempDir } from './helpers.js';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('validate', () => {
  it('slugifies like v1', () => {
    assert.equal(slugify('Home Assistant!'), 'home-assistant');
    assert.equal(slugify('***'), 'icon');
  });
  it('strips control and bidi characters from names', () => {
    assert.equal(normalizeName('a\u0000b\u202ec  d', 'x'), 'abc d');
    assert.throws(() => normalizeName('', ''), /Name is invalid/);
    assert.equal(normalizeName(undefined, 'fallback'), 'fallback');
  });
  it('parses and deduplicates tags', () => {
    assert.deepEqual(parseTags(' A, b ,a,, '), ['a', 'b']);
    assert.deepEqual(parseTags(null), []);
    assert.throws(() => parseTags([1]), AppError);
    assert.throws(() => parseTags({}), AppError);
  });
  it('accepts only bare, allowed filenames', () => {
    assert.equal(isSafeFilename('proxmox_abc123defg.png'), true);
    for (const bad of ['../x.png', 'a/b.png', '.hidden.png', 'x.html', 'x.png/', 'C:\\x.png', '', 5]) {
      assert.equal(isSafeFilename(bad), false, String(bad));
    }
  });
});

describe('errors', () => {
  it('maps library errors to stable codes', () => {
    assert.equal(fromLibraryError({ code: 'LIMIT_FILE_SIZE' })?.code, 'file_too_large');
    assert.equal(fromLibraryError({ code: 'LIMIT_PART_COUNT' })?.code, 'invalid_body');
    assert.equal(fromLibraryError({ type: 'entity.too.large' })?.code, 'body_too_large');
    assert.equal(fromLibraryError({ status: 400 })?.code, 'invalid_body');
    assert.equal(fromLibraryError(new Error('x')), null);
  });

  it('hides internals of unexpected errors', () => {
    const lines = [];
    const handler = errorHandler(createLogger({ write: (l) => lines.push(l) }));
    let status = 0;
    let body;
    const res = /** @type {any} */ ({
      headersSent: false,
      status(s) {
        status = s;
        return this;
      },
      json(b) {
        body = b;
      },
    });
    handler(new Error('secret stack detail'), /** @type {any} */ ({ path: '/x', method: 'GET' }), res, () => {});
    assert.equal(status, 500);
    assert.equal(body.code, 'internal_error');
    assert.ok(!JSON.stringify(body).includes('secret'));
    assert.ok(
      lines.some((l) => l.includes('secret stack detail')),
      'details go to the log',
    );

    let destroyed = false;
    handler(
      new Error('late'),
      /** @type {any} */ ({ path: '/x', method: 'GET' }),
      /** @type {any} */ ({ headersSent: true, destroy: () => (destroyed = true) }),
      () => {},
    );
    assert.equal(destroyed, true);
  });
});

describe('log', () => {
  it('filters by level', () => {
    const lines = [];
    const log = createLogger({ level: 'warn', write: (l) => lines.push(JSON.parse(l)) });
    log.info('hidden');
    log.warn('shown', { a: 1 });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].a, 1);
  });

  it('appends audit events to a file when configured', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'audit.log');
    const audit = createAudit(createLogger({ write: () => {} }), file);
    audit('login', { outcome: 'success' });
    audit('delete', { id: 'x' });
    await new Promise((r) => setTimeout(r, 50));
    const lines = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => l.audit),
      ['login', 'delete'],
    );
    await fs.rm(dir, { recursive: true, force: true });
  });
});
