// Commit properties: random sequences of document operations; after each one `brain doctor` is
// clean (Yjs text = head, rev without gaps, hashes correct), earlier revisions do not change, and
// the head matches the model.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryResult, ReadResult, WriteResult } from '../helpers/api.js';
import { ApiError, type Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

interface ModelDoc {
  id: string;
  path: string;
  deleted: boolean;
  /** The body of each revision by number (1..head). */
  bodies: string[];
}

function rng(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s % n;
  };
}

describe('commit properties', () => {
  let h: Harness;
  let w: World;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it.each([1, 7, 2026])('random sequence (seed %i): doctor clean after every step, history immutable, head matches', async (seed) => {
    const rnd = rng(seed);
    const clients: Client[] = [w.client('alice-helper'), w.client('alice-assistant')];
    const docs: ModelDoc[] = [];
    const words = ['alpha', 'beta', 'γάμμα', 'δέλτα', '🧠', '# Title', '\n', '\n\n', 'line\n'];
    const text = () => Array.from({ length: 1 + rnd(12) }, () => words[rnd(words.length)]).join(' ');
    const livePaths = () => new Set(docs.filter((d) => !d.deleted).map((d) => d.path.toLowerCase()));
    const freshPath = () => {
      for (;;) {
        const p = `${['a', 'b', 'c/d'][rnd(3)]}/doc${rnd(30)}.md`;
        if (!livePaths().has(p.toLowerCase())) return p;
      }
    };
    const dump = () => h.core.db.prepare('SELECT * FROM revisions ORDER BY seq').all();

    for (let step = 0; step < 60; step++) {
      const c = clients[rnd(clients.length)]!;
      const before = dump();
      const live = docs.filter((d) => !d.deleted);
      const dead = docs.filter((d) => d.deleted);
      const action = docs.length === 0 ? 0 : rnd(7);
      try {
        if (action === 0 || (live.length === 0 && action !== 5)) {
          const path = freshPath();
          const body = text();
          const r = await c.call<WriteResult>('write', { space: 'shared', path, content: body, message: `create ${step}` });
          docs.push({ id: r.doc!.id, path, deleted: false, bodies: [body] });
        } else if (action <= 2) {
          const d = live[rnd(live.length)]!;
          const stale = rnd(4) === 0;
          const expected = stale ? Math.max(0, d.bodies.length - 1 - rnd(2)) : d.bodies.length;
          const body = rnd(5) === 0 ? d.bodies[d.bodies.length - 1]! : text();
          const r = await c.raw<WriteResult>('write', { space: 'shared', path: d.path, content: body, expected_rev: expected, message: `update ${step}` });
          if (expected !== d.bodies.length) {
            expect(r.status).toBe(409);
          } else {
            expect(r.status).toBe(200);
            const res = (r.body as { result: WriteResult }).result;
            if (body === d.bodies[d.bodies.length - 1]) expect(res.unchanged).toBe(true);
            else d.bodies.push(body);
          }
        } else if (action === 3) {
          const d = live[rnd(live.length)]!;
          const to = freshPath();
          await c.call('move', { id: d.id, to_path: to });
          d.path = to;
          d.bodies.push(d.bodies[d.bodies.length - 1]!);
        } else if (action === 4) {
          const d = live[rnd(live.length)]!;
          await c.call('delete', { id: d.id });
          d.deleted = true;
          d.bodies.push(d.bodies[d.bodies.length - 1]!);
        } else if (action === 5 && dead.length > 0) {
          const d = dead[rnd(dead.length)]!;
          const r = await c.raw('restore', { id: d.id });
          if (livePaths().has(d.path.toLowerCase())) {
            expect(r.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'path_taken' } } });
          } else {
            expect(r.status).toBe(200);
            d.deleted = false;
            d.bodies.push(d.bodies[d.bodies.length - 1]!);
          }
        } else if (live.length > 0) {
          const d = live[rnd(live.length)]!;
          const to = 1 + rnd(d.bodies.length);
          const r = await c.call<WriteResult>('revert', { id: d.id, to_rev: to, message: `revert ${step}` });
          if (d.bodies[to - 1] === d.bodies[d.bodies.length - 1]) expect(r.unchanged).toBe(true);
          else d.bodies.push(d.bodies[to - 1]!);
        }
      } catch (err) {
        if (err instanceof ApiError) throw new Error(`step ${step} action ${action}: ${err.code} ${JSON.stringify(err.details)}`, { cause: err });
        throw err;
      }
      const report = h.doctor();
      expect(report.problems, `step ${step}`).toEqual([]);
      expect(dump().slice(0, before.length), `step ${step}`).toEqual(before);
    }

    // The head and every revision match the model.
    const hermes = clients[0]!;
    for (const d of docs) {
      const head = await hermes.call<ReadResult>('read', { id: d.id });
      expect(head.doc.rev).toBe(d.bodies.length);
      expect(head.doc.deleted).toBe(d.deleted);
      expect(head.doc.path).toBe(d.path);
      expect(head.content).toBe(d.bodies[d.bodies.length - 1]);
      const hist = await hermes.call<HistoryResult>('history', { id: d.id, limit: 200 });
      expect(hist.revisions.map((r) => r.rev)).toEqual(d.bodies.map((_, i) => d.bodies.length - i));
      for (let rev = 1; rev <= d.bodies.length; rev++) {
        expect((await hermes.call<ReadResult>('read', { id: d.id, rev })).content).toBe(d.bodies[rev - 1]);
      }
    }
  }, 60_000);
});
