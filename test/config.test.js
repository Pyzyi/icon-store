import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { KEY } from './helpers.js';

describe('config', () => {
  it('refuses to start without ADMIN_KEY', () => {
    assert.throws(
      () => loadConfig({}),
      (err) => err instanceof ConfigError && /ADMIN_KEY is missing/.test(err.message),
    );
  });

  it('refuses keys shorter than 32 characters', () => {
    assert.throws(() => loadConfig({ ADMIN_KEY: 'a'.repeat(31) }), /too short/);
  });

  it('refuses the placeholder from the compose file', () => {
    assert.throws(() => loadConfig({ ADMIN_KEY: 'BITTE_AENDERN_openssl_rand_hex_32_ausfuehren' }), /placeholder/);
    // The current compose.yaml placeholder (31 chars) and a padded variant are both refused.
    assert.throws(() => loadConfig({ ADMIN_KEY: 'CHANGE_ME_generate_a_random_key' }), /too short/);
    assert.throws(() => loadConfig({ ADMIN_KEY: 'CHANGE_ME_generate_a_random_key_padded' }), /placeholder/);
  });

  it('allows no key only with ALLOW_INSECURE_NO_AUTH=true', () => {
    const c = loadConfig({ ALLOW_INSECURE_NO_AUTH: 'true' });
    assert.equal(c.insecureNoAuth, true);
    assert.equal(c.adminKey, null);
  });

  it('applies secure defaults', () => {
    const c = loadConfig({ ADMIN_KEY: KEY });
    assert.equal(c.port, 3000);
    assert.equal(c.maxUploadBytes, 8 * 1024 * 1024);
    assert.equal(c.publicBrowse, false);
    assert.equal(c.allowApiBearer, false);
    assert.equal(c.reencodeRaster, true);
    assert.equal(c.trustProxy, false);
    assert.equal(c.loginRateLimit, 5);
  });

  it('reports every invalid variable at once', () => {
    try {
      loadConfig({
        ADMIN_KEY: KEY,
        PORT: 'abc',
        MAX_UPLOAD_MB: '0',
        PUBLIC_BROWSE: 'maybe',
        COOKIE_SECURE: 'x',
        ALLOWED_ORIGINS: 'nope',
      });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 5);
    }
  });

  it('parses TRUST_PROXY, lists and numbers', () => {
    assert.equal(loadConfig({ ADMIN_KEY: KEY, TRUST_PROXY: '1' }).trustProxy, 1);
    assert.equal(loadConfig({ ADMIN_KEY: KEY, TRUST_PROXY: 'true' }).trustProxy, true);
    assert.equal(loadConfig({ ADMIN_KEY: KEY, TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
    const c = loadConfig({
      ADMIN_KEY: KEY,
      ALLOWED_ORIGINS: 'https://a.example/, https://b.example',
      MAX_TOTAL_SIZE_MB: '5',
      PUBLIC_BROWSE: 'yes',
      AUDIT_LOG_FILE: 'audit.log',
    });
    assert.deepEqual(c.allowedOrigins, ['https://a.example', 'https://b.example']);
    assert.equal(c.maxTotalBytes, 5 * 1024 * 1024);
    assert.equal(c.publicBrowse, true);
    assert.match(String(c.auditLogFile), /audit\.log$/);
  });
});
