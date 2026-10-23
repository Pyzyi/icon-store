import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createKeyVerifier, SessionStore } from '../src/lib/auth.js';
import { createAudit, createLogger } from '../src/lib/log.js';
import { Store } from '../src/lib/storage.js';

/** Generated per run – no real secret is ever committed. */
export const KEY = randomBytes(32).toString('hex');
export const HOST = 'icons.test';
export const ORIGIN = `http://${HOST}`;

export async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'icon-store-test-'));
}

/** Logger that records lines instead of printing them. */
export function memoryLogger() {
  /** @type {any[]} */
  const lines = [];
  const log = createLogger({ level: 'debug', write: (line) => lines.push(JSON.parse(line)) });
  return { log, lines };
}

/**
 * @param {Record<string, string>} [env]
 * @param {{ dataDir?: string }} [opts]
 */
export async function setup(env = {}, opts = {}) {
  const dataDir = opts.dataDir ?? (await tempDir());
  const config = loadConfig({ ADMIN_KEY: KEY, DATA_DIR: dataDir, ...env });
  const { log, lines } = memoryLogger();
  const store = new Store({ dataDir: config.dataDir, maxTotalBytes: config.maxTotalBytes, log });
  await store.init();
  const sessions = new SessionStore(config.sessionTtlMs);
  const app = createApp({
    config,
    store,
    sessions,
    verifyKey: createKeyVerifier(config.adminKey),
    log,
    audit: createAudit(log, config.auditLogFile),
  });
  /** Agent that looks like a same-origin browser. */
  const agent = () => request.agent(app).set('Host', HOST).set('Origin', ORIGIN);
  const cleanup = async () => {
    sessions.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  };
  return { app, store, config, dataDir, lines, agent, sessions, cleanup };
}

/** @param {ReturnType<Awaited<ReturnType<typeof setup>>['agent']>} agent */
export async function login(agent) {
  const res = await agent.post('/api/login').send({ key: KEY });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return agent;
}

/** @param {Awaited<ReturnType<typeof setup>>} ctx */
export async function loggedIn(ctx) {
  return login(ctx.agent());
}

const base = () => sharp({ create: { width: 16, height: 16, channels: 4, background: '#3fd0c4' } });

export const fixtures = {
  png: () => base().png().toBuffer(),
  jpg: () => base().flatten().jpeg().toBuffer(),
  webp: () => base().webp().toBuffer(),
  gif: () => base().gif().toBuffer(),
  /** Minimal ICO container with one embedded PNG image. */
  async ico() {
    const png = await base().png().toBuffer();
    const header = Buffer.alloc(22);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header.writeUInt8(16, 6);
    header.writeUInt8(16, 7);
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(22, 18);
    return Buffer.concat([header, png]);
  },
  svg: () =>
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="teal"/></svg>',
    ),
  maliciousSvg: () =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" onload="alert(1)">
        <script>alert(document.cookie)</script>
        <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(2)">x</div></foreignObject>
        <a href="javascript:alert(3)"><circle r="4" onmouseover="alert(4)"/></a>
        <use xlink:href="https://evil.example/sprite.svg#x"/>
        <image href="https://evil.example/track.png"/>
        <rect width="2" height="2" fill="url(https://evil.example/x)"/>
        <style>@import url(https://evil.example/a.css); .a{fill:red}</style>
        <path d="M0 0h24v24H0z" fill="teal"/>
      </svg>`,
    ),
};

/** Small helper for building a v1 data directory like the original app wrote it. */
export async function writeV1Data(dataDir, entries, files) {
  await fs.mkdir(path.join(dataDir, 'icons'), { recursive: true });
  for (const [name, buf] of Object.entries(files)) await fs.writeFile(path.join(dataDir, 'icons', name), buf);
  await fs.writeFile(path.join(dataDir, 'metadata.json'), JSON.stringify({ icons: entries }, null, 2));
}
