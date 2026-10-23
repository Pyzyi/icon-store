/**
 * Search benchmark: 5,000 icons, realistic names/tags, the queries a user
 * types. Fails (exit 1) if the 95th percentile reaches the 50 ms budget, so
 * it can run in CI.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildSearchIndex, search } from '../src/lib/search.js';

const ICON_COUNT = 5000;
const RUNS = 500;
const BUDGET_MS = 50;
const WORDS = [
  'proxmox',
  'home',
  'assistant',
  'jellyfin',
  'plex',
  'grafana',
  'docker',
  'nas',
  'router',
  'cloud',
  'media',
  'backup',
];

/** @param {number} i */
const word = (i) => WORDS[i % WORDS.length];
const icons = Array.from({ length: ICON_COUNT }, (_, i) => ({
  id: randomUUID(),
  name: `${word(i)} ${word(i * 7)} ${i}`,
  filename: `${word(i)}-${i}_abcdefghij.png`,
  tags: [word(i * 3), word(i * 5), `tag${i % 50}`],
  size: 1000,
  uploadedAt: new Date().toISOString(),
  contentType: 'image/png',
  sha256: '',
}));

const indexStart = performance.now();
const index = buildSearchIndex(icons);
const indexMs = performance.now() - indexStart;

const queries = ['prox', 'home ass', 'tag4', 'zzz-no-match', 'a', '', 'jellyfin 12', 'MEDIA'];
const times = [];
for (let r = 0; r < RUNS; r++) {
  const q = queries[r % queries.length];
  const t0 = performance.now();
  search(index, q);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
const result = {
  icons: ICON_COUNT,
  runs: RUNS,
  indexBuildMs: +indexMs.toFixed(2),
  medianMs: +pct(50).toFixed(3),
  p95Ms: +pct(95).toFixed(3),
  maxMs: +times[times.length - 1].toFixed(3),
  budgetMs: BUDGET_MS,
};
console.log(JSON.stringify(result, null, 2));
if (result.p95Ms >= BUDGET_MS) {
  console.error(`FAIL: p95 ${result.p95Ms} ms >= ${BUDGET_MS} ms`);
  process.exit(1);
}
console.log('OK: search stays below budget');
