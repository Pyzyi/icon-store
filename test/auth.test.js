import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createKeyVerifier, readCookie, SessionStore } from '../src/lib/auth.js';
import { fixtures, HOST, KEY, login, ORIGIN, setup } from './helpers.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('authentication', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let ctx;
  before(async () => {
    ctx = await setup();
  });
  after(() => ctx.cleanup());

  it('returns 401 on every protected endpoint without login', async () => {
    const a = ctx.agent();
    const cases = [
      a.get('/api/icons'),
      ctx
        .agent()
        .post('/api/icons')
        .attach('file', await fixtures.png(), 'x.png'),
      ctx.agent().patch(`/api/icons/${ID}`).send({ name: 'x' }),
      ctx.agent().delete(`/api/icons/${ID}`),
      ctx.agent().get('/api/export'),
      ctx.agent().post('/api/import').attach('file', Buffer.from('PK'), 'b.zip'),
    ];
    for (const res of await Promise.all(cases)) {
      assert.equal(res.status, 401, `${res.req.method} ${res.req.path}`);
      assert.equal(res.body.code, 'auth_required');
    }
  });

  it('ignores the legacy ?key= query parameter and X-Admin-Key header', async () => {
    const res = await ctx.agent().get(`/api/icons?key=${KEY}`).set('X-Admin-Key', KEY);
    assert.equal(res.status, 401);
  });

  it('rejects a wrong key', async () => {
    const res = await ctx.agent().post('/api/login').send({ key: 'wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'invalid_credentials');
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('sets an HttpOnly, SameSite=Strict session cookie and logs the login', async () => {
    const a = ctx.agent();
    const res = await a.post('/api/login').send({ key: KEY });
    assert.equal(res.status, 200);
    const cookie = String(res.headers['set-cookie']);
    assert.match(cookie, /iconstore_sid=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.equal((await a.get('/api/icons')).status, 200);
    const audit = ctx.lines.filter((l) => l.audit === 'login');
    assert.ok(audit.some((l) => l.outcome === 'success'));
    assert.ok(!JSON.stringify(ctx.lines).includes(KEY), 'admin key must never be logged');
  });

  it('logout invalidates the session', async () => {
    const a = await login(ctx.agent());
    assert.equal((await a.post('/api/logout')).status, 200);
    assert.equal((await a.get('/api/icons')).status, 401);
  });

  it('reports session state', async () => {
    const res = await ctx.agent().get('/api/session');
    assert.deepEqual(
      { ...res.body, maxUploadBytes: undefined },
      { authenticated: false, authRequired: true, publicBrowse: false, maxUploadBytes: undefined },
    );
  });

  it('rejects state-changing requests from a foreign or missing Origin (CSRF)', async () => {
    const a = await login(ctx.agent());
    const foreign = await a.patch(`/api/icons/${ID}`).set('Origin', 'https://evil.example').send({ name: 'x' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, 'forbidden_origin');

    const none = await request(ctx.app).post('/api/login').set('Host', HOST).send({ key: KEY });
    assert.equal(none.status, 403);

    const viaReferer = await request(ctx.app)
      .post('/api/login')
      .set('Host', HOST)
      .set('Referer', `${ORIGIN}/index.html`)
      .send({ key: 'wrong' });
    assert.equal(viaReferer.status, 401, 'same-origin Referer is accepted as fallback');
  });

  it('marks the cookie Secure when COOKIE_SECURE=true', async () => {
    const s = await setup({ COOKIE_SECURE: 'true' });
    try {
      const res = await s.agent().post('/api/login').send({ key: KEY });
      assert.match(String(res.headers['set-cookie']), /Secure/);
    } finally {
      await s.cleanup();
    }
  });

  it('rate-limits login attempts per IP', async () => {
    const s = await setup({ LOGIN_RATE_LIMIT: '5' });
    try {
      const statuses = [];
      for (let i = 0; i < 6; i++) statuses.push((await s.agent().post('/api/login').send({ key: 'nope' })).status);
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
      const ok = await s.agent().post('/api/login').send({ key: KEY });
      assert.equal(ok.status, 429, 'even the right key is blocked while limited');
    } finally {
      await s.cleanup();
    }
  });

  it('accepts a Bearer token only when ALLOW_API_BEARER=true', async () => {
    const off = await request(ctx.app).get('/api/icons').set('Authorization', `Bearer ${KEY}`);
    assert.equal(off.status, 401);
    const s = await setup({ ALLOW_API_BEARER: 'true' });
    try {
      const ok = await request(s.app).get('/api/icons').set('Authorization', `Bearer ${KEY}`);
      assert.equal(ok.status, 200);
      // No Origin needed: browsers cannot attach this header cross-site.
      const up = await request(s.app)
        .post('/api/icons')
        .set('Authorization', `Bearer ${KEY}`)
        .attach('file', await fixtures.png(), 'b.png');
      assert.equal(up.status, 201);
      const bad = await request(s.app).get('/api/icons').set('Authorization', 'Bearer wrong');
      assert.equal(bad.status, 401);
    } finally {
      await s.cleanup();
    }
  });

  it('PUBLIC_BROWSE allows reading but not writing', async () => {
    const s = await setup({ PUBLIC_BROWSE: 'true' });
    try {
      assert.equal((await s.agent().get('/api/icons')).status, 200);
      assert.equal((await s.agent().delete(`/api/icons/${ID}`)).status, 401);
    } finally {
      await s.cleanup();
    }
  });

  it('ALLOW_INSECURE_NO_AUTH disables the login requirement', async () => {
    const s = await setup({ ADMIN_KEY: '', ALLOW_INSECURE_NO_AUTH: 'true' });
    try {
      const res = await s.agent().get('/api/session');
      assert.equal(res.body.authRequired, false);
      assert.equal((await s.agent().get('/api/icons')).status, 200);
      assert.equal((await s.agent().post('/api/login').send({ key: 'anything' })).status, 401);
    } finally {
      await s.cleanup();
    }
  });
});

describe('auth primitives', () => {
  it('verifies keys in constant time over hashes', () => {
    const verify = createKeyVerifier(KEY);
    assert.equal(verify(KEY), true);
    assert.equal(verify(`${KEY}x`), false);
    assert.equal(verify(''), false);
    assert.equal(verify(undefined), false);
    assert.equal(verify({}), false);
    assert.equal(createKeyVerifier(null)('x'), false);
  });

  it('expires sessions', () => {
    const sessions = new SessionStore(-1);
    const token = sessions.create();
    assert.equal(sessions.touch(token), false);
    assert.equal(sessions.touch(undefined), false);
    const live = new SessionStore(60_000);
    const t2 = live.create();
    assert.equal(live.touch(t2), true);
    live.sweep();
    assert.equal(live.touch(t2), true);
    live.destroy(t2);
    assert.equal(live.touch(t2), false);
    sessions.close();
    live.close();
  });

  it('sweeps expired sessions', () => {
    const sessions = new SessionStore(-1);
    const token = sessions.create();
    sessions.sweep();
    assert.equal(sessions.touch(token), false);
    sessions.close();
  });

  it('parses cookies', () => {
    assert.equal(readCookie('a=1; iconstore_sid=abc; b=2', 'iconstore_sid'), 'abc');
    assert.equal(readCookie('a=1', 'iconstore_sid'), undefined);
    assert.equal(readCookie(undefined, 'x'), undefined);
  });
});
