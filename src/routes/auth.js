import { Router } from 'express';
import { SESSION_COOKIE } from '../constants.js';
import { isSecureCookie, readCookie } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';

/**
 * @param {import('../app.js').AppDeps & { loginLimiter: import('express').RequestHandler }} deps
 */
export function authRouter({ config, sessions, verifyKey, audit, loginLimiter }) {
  const router = Router();

  router.get('/session', (req, res) => {
    res.json({
      authenticated: Boolean(res.locals.authenticated),
      authRequired: !config.insecureNoAuth,
      publicBrowse: config.publicBrowse,
      maxUploadBytes: config.maxUploadBytes,
    });
  });

  router.post('/login', loginLimiter, (req, res) => {
    if (!verifyKey(req.body?.key)) {
      audit('login', { ip: req.ip, outcome: 'failure' });
      throw new AppError(401, 'invalid_credentials');
    }
    const token = sessions.create();
    // No maxAge: the server-side sliding expiry decides; the browser forgets the cookie on close.
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isSecureCookie(req, config.cookieSecure),
      path: '/',
    });
    audit('login', { ip: req.ip, outcome: 'success' });
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    sessions.destroy(readCookie(req.get('cookie'), SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict' });
    audit('logout', { ip: req.ip });
    res.json({ ok: true });
  });

  return router;
}
