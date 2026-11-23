// Fully replacing a document at the size limit (512 KB) must not tie up the process for seconds.
// Previously applyText and diff called the quadratic diffLines: 4000 lines took 4.5 s per write
// and 10 s per diff, 512 KB on the order of an hour. Now writes are linear, and diff is bounded
// (maxEditLength + timeout) and beyond the ceiling returns an estimate without text. The time
// ceilings leave headroom for a Raspberry Pi 5 under parallel ci load; before the fix the test
// did not even fit within the timeout.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WriteResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const LIMIT = 512 * 1024;

/** Text of exactly up to 512 KB made of short distinct lines (worst case for a line diff). */
function bigDoc(tag: string): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; ; i++) {
    const line = `${tag} line ${i} lorem ipsum\n`;
    if (size + line.length > LIMIT) break;
    lines.push(line);
    size += line.length;
  }
  return lines.join('');
}

/** Ceiling for one operation (ms). Without the fix: minutes. */
const CEILING_MS = 4_000;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

describe('perf/large diff', () => {
  let h: Harness;
  let w: World;
  let hermes: Client;
  const A = bigDoc('alpha');
  const B = bigDoc('bravo');

  beforeAll(async () => {
    h = await startHarness();
    w = buildWorld(h);
    hermes = w.client('alice-helper');
  }, 60_000);
  afterAll(async () => {
    expect(h.doctor().problems).toEqual([]);
    await h.close();
  }, 60_000);

  it('512 KB document fully replaced: write, stale write (conflict), diff, stat and proposal_get stay bounded', async () => {
    expect(Buffer.byteLength(A)).toBeGreaterThan(LIMIT - 64);
    expect(Buffer.byteLength(A)).toBeLessThanOrEqual(LIMIT);
    const first = await hermes.call<WriteResult>('write', { space: 'shared', path: 'big.md', content: A, message: 'v1' });
    expect(first.doc!.rev).toBe(1);

    // Full replacement with expected_rev: every line differs.
    const replace = await timed(() => hermes.call<WriteResult>('write', { space: 'shared', path: 'big.md', content: B, expected_rev: 1, message: 'v2' }));
    expect(replace.value.doc!.rev).toBe(2);
    expect(replace.ms).toBeLessThan(CEILING_MS);

    // Stale write: conflict with a diff from expected_rev to the head, inside the write transaction.
    const stale = await timed(() => hermes.raw('write', { space: 'shared', path: 'big.md', content: A, expected_rev: 1, message: 'stale' }));
    expect(stale.value.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'stale', diff_truncated: true } } });
    expect(stale.ms).toBeLessThan(CEILING_MS);

    // diff and stat on a fully rewritten document: no text, with an estimate, fast.
    const diff = await timed(() =>
      hermes.call<{ diff?: string; added: number; removed: number; truncated: boolean }>('diff', { space: 'shared', path: 'big.md', from: 1 }),
    );
    expect(diff.ms).toBeLessThan(CEILING_MS);
    const lines = A.split('\n').length - 1;
    expect(diff.value).toMatchObject({ truncated: true, added: lines, removed: lines });
    expect(diff.value.diff).toBeUndefined();
    const stat = await timed(() => hermes.call('diff', { space: 'shared', path: 'big.md', from: 1, format: 'stat' }));
    expect(stat.ms).toBeLessThan(CEILING_MS);
    expect(stat.value).toMatchObject({ truncated: true, added: lines, removed: lines });

    // Repeated diffs (read, limit 300/min): each one is bounded.
    const repeat = await timed(async () => {
      for (let i = 0; i < 5; i++) await hermes.call('diff', { space: 'shared', path: 'big.md', from: 1 });
    });
    expect(repeat.ms).toBeLessThan(CEILING_MS * 2);

    // A small edit in the same large document gives an exact diff, as before.
    const C = B.replace('bravo line 100 lorem', 'bravo line 100 LOREM');
    await hermes.call('write', { space: 'shared', path: 'big.md', content: C, expected_rev: 2, message: 'v3' });
    const small = await hermes.call<{ diff?: string; added: number; removed: number; truncated: boolean }>('diff', {
      space: 'shared',
      path: 'big.md',
      from: 2,
    });
    expect(small).toMatchObject({ truncated: false, added: 1, removed: 1 });
    expect(small.diff).toContain('+bravo line 100 LOREM ipsum');

    // proposal_get on a proposal that rewrites everything: the diff is not computed beyond the ceiling.
    w.grant('shared', { principal: 'alphabot' }, 'propose');
    const alphabot = w.client('alphabot');
    const proposed = await alphabot.call<{ status: string; proposal?: { id: string } }>('write', {
      space: 'shared',
      path: 'big.md',
      content: A,
      expected_rev: 3,
      message: 'rewrite',
    });
    expect(proposed.status).toBe('proposed');
    const get = await timed(() => w.client('alice-assistant').call<{ diff: string; diff_truncated?: boolean; content: string }>('proposal_get', { id: proposed.proposal!.id }));
    expect(get.ms).toBeLessThan(CEILING_MS);
    expect(get.value).toMatchObject({ diff: '', diff_truncated: true });
    expect(get.value.content).toBe(A);
  }, 180_000);
});
