// Memory: 2000 documents of 20 KB, 10 revisions each, 500 searches and 500 reads;
// RSS < 300 MB. The load runs in a separate process (test/perf/memory-run.ts) so that peak RSS
// is measured without vitest and neighbouring tests, and from compiled JS (as in production, without
// the tsx loader, which itself takes ~40 MB). PERF_DOCS/PERF_REVS reduce the volume for local runs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const LIMIT = 300 * 1024 * 1024;

/** V8 flags of the production launch (`npm start`): the test measures the same process configuration. */
function startFlags(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: { start: string } };
  return pkg.scripts.start.split(/\s+/).filter((a) => a.startsWith('--max-old-space-size='));
}

describe('perf/memory', () => {
  it('2000 docs × 10 revisions, 500 searches, 500 reads: peak RSS < 300 MB', () => {
    const tsc = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.perf.json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
    });
    expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
    const flags = startFlags();
    expect(flags).toHaveLength(1);
    const r = spawnSync(process.execPath, [...flags, path.join(ROOT, '.perf-dist/test/perf/memory-run.js')], {
      cwd: ROOT,
      env: { ...process.env, PERF_DETAIL: '1' },
      encoding: 'utf8',
      timeout: 1_500_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as { peak_rss: number; writes: number };
    expect(out.writes).toBe(Number(process.env.PERF_DOCS ?? 2000) * Number(process.env.PERF_REVS ?? 10));
    expect(out.peak_rss, JSON.stringify(out)).toBeLessThan(LIMIT);
  }, 1_600_000);
});
