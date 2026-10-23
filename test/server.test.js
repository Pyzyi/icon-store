import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KEY, tempDir } from './helpers.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/** @param {Record<string, string>} env */
function start(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

/** @param {() => string} output @param {RegExp} re */
async function waitFor(output, re, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(output())) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${re}; output:\n${output()}`);
}

describe('server process', () => {
  it('exits with an error when ADMIN_KEY is missing', async () => {
    const dir = await tempDir();
    const s = start({ DATA_DIR: dir });
    assert.equal(await s.exited, 78);
    assert.match(s.output(), /ADMIN_KEY is missing/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exits with an error on corrupt metadata', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'metadata.json'), '{broken');
    const s = start({ DATA_DIR: dir, ADMIN_KEY: KEY });
    assert.equal(await s.exited, 78);
    assert.match(s.output(), /not valid JSON/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts with a warning when auth is explicitly disabled, and shuts down cleanly on SIGTERM', async () => {
    const dir = await tempDir();
    const port = await freePort();
    const s = start({ DATA_DIR: dir, PORT: String(port), ALLOW_INSECURE_NO_AUTH: 'true' });
    await waitFor(s.output, /listening/);
    assert.match(s.output(), /AUTHENTICATION IS DISABLED/);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    s.child.kill('SIGTERM');
    assert.equal(await s.exited, 0);
    assert.match(s.output(), /shutdown complete/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
