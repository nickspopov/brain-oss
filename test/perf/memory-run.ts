// Load for perf/memory.test.ts: a separate process so RSS is measured without vitest and
// other tests. N documents of ~20 KB, R revisions each, then searches and reads through the same
// execute pipeline the adapters use. Prints JSON: peak RSS, time, number of operations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPrincipal } from '../../src/core/principals.js';
import { setGrant } from '../../src/core/grants.js';
import { createSpace } from '../../src/core/spaces.js';
import { contextFor } from '../../src/core/guard.js';
import type { Caller } from '../../src/ops/execute.js';

const DOCS = Number(process.env.PERF_DOCS ?? 2000);
const REVS = Number(process.env.PERF_REVS ?? 10);
const SEARCHES = Number(process.env.PERF_SEARCHES ?? 500);
const READS = Number(process.env.PERF_READS ?? 500);
const DOC_BYTES = 20 * 1024;

const WORDS = (
  'brain memory agent space document revision search index token backup export import archive handoff recipe ' +
  'project roadmap meeting summary decision context review proposal curator trust secret quota limit vector ' +
  'память агент пространство документ ревизия поиск индекс резервная копия экспорт импорт проект встреча решение'
).split(' ');

let seed = 42;
const rand = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

function paragraph(i: number): string {
  const words: string[] = [];
  for (let k = 0; k < 60; k++) words.push(WORDS[rand(WORDS.length)]!);
  return `${words.join(' ')} p${i}-${rand(1e6)}.`;
}

function body(doc: number, rev: number): string {
  const parts = [`# Document ${doc}\n\ntags: perf\n`];
  let size = parts[0]!.length;
  let i = 0;
  while (size < DOC_BYTES) {
    // Each revision changes one paragraph out of ten; the rest stay stable.
    const p = i % 10 === rev % 10 ? `rev ${rev} ${paragraph(i)}` : `stable ${doc} ${i} ${WORDS[(doc + i) % WORDS.length]} ${'lorem ipsum dolor sit amet '.repeat(12)}`;
    parts.push(`\n## Section ${i}\n\n${p}\n`);
    size += p.length + 20;
    i++;
  }
  return parts.join('');
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(process.env.PERF_DIR ?? os.tmpdir(), 'brain-perf-'));
  let peak = 0;
  let atPeak: NodeJS.MemoryUsage | undefined;
  const sample = (): void => {
    const rss = process.memoryUsage.rss();
    if (rss > peak) {
      peak = rss;
      if (process.env.PERF_DETAIL) atPeak = process.memoryUsage();
    }
  };
  const timer = setInterval(sample, 50);
  const started = Date.now();
  const app = createApp(
    loadConfig({
      BRAIN_DEV: '0',
      BRAIN_ORIGIN: 'https://brain.example',
      BRAIN_DATA_DIR: dataDir,
      BRAIN_LOG_LEVEL: 'silent',
      BRAIN_BACKGROUND: '0',
      BRAIN_RATE_WRITE: '1000000',
      BRAIN_RATE_READ: '1000000',
      BRAIN_RATE_SEARCH: '1000000',
    }),
  );
  try {
    const core = app.core;
    const rssStart = process.memoryUsage.rss();
    const agent = createPrincipal(core, { name: 'perf-agent', kind: 'agent', trust: 'admin' }, null);
    const space = createSpace(core, { slug: 'perf', quotaBytes: 4 * 1024 * 1024 * 1024 }, null);
    setGrant(core, { spaceId: space.id, scope: 'space', pathPrefix: null, docId: null, role: 'write', subjectType: 'principal', subjectId: agent.id }, null);
    const principal = contextFor(core, { id: agent.id, name: agent.name, kind: 'agent', role: 'member', trust: 'admin', admin: false }).principal;
    const caller: Caller = { principal, via: 'rest', ip: null };
    const call = async (op: string, input: unknown): Promise<unknown> => {
      const r = await app.executor.execute(op, input, caller);
      if (!r.ok) throw new Error(`${op}: ${r.error.code} ${r.error.message}`);
      return r.result;
    };
    const ids: string[] = [];
    for (let rev = 1; rev <= REVS; rev++) {
      for (let d = 0; d < DOCS; d++) {
        const r = (await call('write', {
          space: 'perf',
          path: `docs/${d % 50}/doc-${d}.md`,
          content: body(d, rev),
          ...(rev > 1 ? { expected_rev: rev - 1 } : {}),
          message: `rev ${rev}`,
        })) as { doc: { id: string } };
        if (rev === 1) ids.push(r.doc.id);
        if (d % 200 === 0) sample();
        if (process.env.PERF_TRACE && d % 500 === 0) process.stderr.write(`${rev}/${d} rss=${Math.round(process.memoryUsage.rss() / 1e6)} heap=${Math.round(process.memoryUsage().heapUsed / 1e6)}/${Math.round(process.memoryUsage().heapTotal / 1e6)} ext=${Math.round(process.memoryUsage().external / 1e6)}\n`);
        if (process.env.PERF_GC && d % 50 === 0) (globalThis as { gc?: () => void }).gc?.();
      }
    }
    const writesDone = Date.now();
    const rssAfterWrites = process.memoryUsage.rss();
    for (let i = 0; i < SEARCHES; i++) {
      if (process.env.PERF_TRACE && i % Number(process.env.PERF_TRACE_EVERY ?? 100) === 0) process.stderr.write(`search ${i} rss=${Math.round(process.memoryUsage.rss() / 1e6)} heap=${Math.round(process.memoryUsage().heapUsed / 1e6)}/${Math.round(process.memoryUsage().heapTotal / 1e6)}\n`);
      await call('search', { query: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]}`, limit: 10 });
    }
    const rssAfterSearch = process.memoryUsage.rss();
    for (let i = 0; i < READS; i++) await call('read', { id: ids[(i * 37) % ids.length] });
    sample();
    const dbBytes = fs.statSync(path.join(dataDir, 'brain.db')).size;
    process.stdout.write(
      `${JSON.stringify({ peak_rss: peak, writes: DOCS * REVS, write_ms: writesDone - started, total_ms: Date.now() - started, db_bytes: dbBytes, ...(atPeak ? { at_peak: atPeak, rssAfterWrites, rssAfterSearch, rssStart } : {}) })}\n`,
    );
  } finally {
    clearInterval(timer);
    await app.close();
    if (process.env.PERF_KEEP) process.stderr.write(`kept ${dataDir}\n`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
