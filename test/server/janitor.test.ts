// Janitor: a document in handoff expires by a faked clock and can be restored; the trash is purged
// for good after trash_retention_days; idempotency, sessions, audit reads and orphans in data/blobs
// are cleaned up; during a backup (lock file) body files are not touched.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOpNames } from '../../src/app.js';
import { runJanitor } from '../../src/core/janitor.js';
import { login } from '../../src/core/sessions.js';
import type { HistoryResult, ListResult, ReadResult, WriteResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, ALICE_PASSWORD, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

async function expectCode(p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code, ...(details ? { details } : {}) });
}

describe('janitor', () => {
  let h: Harness;
  let w: World;
  let hermes: Client;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    hermes = w.client('alice-helper');
    alphabot = w.client('alphabot');
  });
  afterEach(async () => {
    expect(h.doctor().problems).toEqual([]);
    expect(h.logs.filter((l) => l.includes('janitor step failed'))).toEqual([]);
    await h.close();
  });

  const janitor = () => runJanitor(h.core, { readOps: readOpNames() });
  const count = (sql: string, ...params: unknown[]) => (h.core.db.prepare(sql).get(...params) as { n: number }).n;

  it('a handoff document expires by the clock (revision expire by system) and is restored', async () => {
    const w1 = await hermes.call<WriteResult>('write', { space: 'handoff', path: 'task.md', content: '# Task\n\nready\n', message: 'handoff' });
    const id = w1.doc!.id;
    expect(Date.parse(w1.doc!.expires_at!) - h.clock.now()).toBeGreaterThan(13 * 86400000);
    h.clock.advanceDays(13);
    expect(janitor().expired).toBe(0);
    expect((await alphabot.call<ReadResult>('read', { id })).content).toBe('# Task\n\nready\n');
    h.clock.advanceDays(2);
    expect(janitor().expired).toBe(1);
    await expectCode(alphabot.call('read', { space: 'handoff', path: 'task.md' }), 'not_found');
    const search = await alphabot.call<{ results: unknown[] }>('search', { query: 'ready', spaces: ['handoff'] });
    expect(search.results).toEqual([]);
    const hist = await alphabot.call<HistoryResult>('history', { id });
    expect(hist.revisions[0]).toMatchObject({ kind: 'expire', author: { name: 'system', kind: 'system' }, via: 'system' });
    const trash = await alphabot.call<ListResult>('list', { space: 'handoff', include_deleted: true });
    expect(trash.entries.map((e) => e.path)).toContain('task.md');
    // A second pass does nothing.
    expect(janitor().expired).toBe(0);
    const back = await alphabot.call<{ doc: { rev: number; expires_at?: string; deleted: boolean } }>('restore', { id });
    expect(back.doc).toMatchObject({ rev: 3, deleted: false });
    expect(Date.parse(back.doc.expires_at!)).toBeGreaterThan(h.clock.now() + 13 * 86400000);
    expect((await alphabot.call<ReadResult>('read', { id })).content).toBe('# Task\n\nready\n');
    // Feed changes: agents see the expiry as an ordinary revision.
    expect(count("SELECT count(*) AS n FROM audit WHERE op = 'expire' AND via = 'system' AND outcome = 'ok'")).toBe(1);
  });

  it('a write before expiry pushes expires_at forward', async () => {
    const w1 = await hermes.call<WriteResult>('write', { space: 'handoff', path: 't.md', content: 'a\n', message: 'a' });
    h.clock.advanceDays(10);
    await hermes.call('write', { space: 'handoff', path: 't.md', content: 'b\n', expected_rev: 1, message: 'b' });
    h.clock.advanceDays(10);
    expect(janitor().expired).toBe(0);
    expect((await hermes.call<ReadResult>('read', { id: w1.doc!.id })).content).toBe('b\n');
  });

  it('trash older than trash_retention_days is erased for good; younger trash stays', async () => {
    const old = await hermes.call<WriteResult>('write', { space: 'handoff', path: 'old.md', content: '# Old\n\nzqtrashcanary\n', message: 'old' });
    const young = await hermes.call<WriteResult>('write', { space: 'handoff', path: 'young.md', content: '# Young\n', message: 'young' });
    await hermes.call('delete', { id: old.doc!.id });
    h.clock.advanceDays(20);
    await hermes.call('delete', { id: young.doc!.id });
    h.clock.advanceDays(11);
    const r = janitor();
    expect(r.purged).toBe(1);
    expect(count('SELECT count(*) AS n FROM documents WHERE id = ?', old.doc!.id)).toBe(0);
    expect(count('SELECT count(*) AS n FROM revisions WHERE doc_id = ?', old.doc!.id)).toBe(0);
    expect(count("SELECT count(*) AS n FROM blobs WHERE text LIKE '%zqtrashcanary%'")).toBe(0);
    await expectCode(hermes.call('restore', { id: old.doc!.id }), 'not_found');
    expect((await hermes.call<{ doc: { path: string } }>('restore', { id: young.doc!.id })).doc.path).toBe('young.md');
  });

  it('spaces without trash_retention_days keep the trash forever', async () => {
    const d = await hermes.call<WriteResult>('write', { space: 'shared', path: 'keep.md', content: 'k\n', message: 'k' });
    await hermes.call('delete', { id: d.doc!.id });
    h.clock.advanceDays(80);
    expect(janitor().purged).toBe(0);
    expect((await hermes.call<{ doc: { path: string } }>('restore', { id: d.doc!.id })).doc.path).toBe('keep.md');
  });

  it('cleans idempotency after 7 days, expired sessions, read audit rows after 180 days; write audit stays', async () => {
    await hermes.call('write', { space: 'shared', path: 'i.md', content: 'i\n', message: 'i', request_id: 'janitor-req-1' });
    await hermes.call('read', { space: 'shared', path: 'i.md' });
    login(h.core, 'alice', ALICE_PASSWORD, { userAgent: 'test', ip: '127.0.0.1' });
    expect(count('SELECT count(*) AS n FROM sessions')).toBe(1);
    h.clock.advanceDays(8);
    const r1 = janitor();
    expect(r1.idempotency).toBe(1);
    expect(r1.sessions).toBe(0);
    expect(count('SELECT count(*) AS n FROM idempotency')).toBe(0);
    expect(r1.auditReads).toBe(0);
    h.clock.advanceDays(180);
    const r2 = janitor();
    expect(r2.auditReads).toBeGreaterThan(0);
    expect(r2.sessions).toBe(1);
    expect(count('SELECT count(*) AS n FROM sessions')).toBe(0);
    expect(count("SELECT count(*) AS n FROM audit WHERE op = 'read'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM audit WHERE op = 'write'")).toBe(1);
  });

  it('orphan blob files are swept, but not while a backup holds the lock', async () => {
    const dir = path.join(h.dataDir, 'blobs', 'ab');
    fs.mkdirSync(dir, { recursive: true });
    const orphan = path.join(dir, 'ab'.padEnd(64, '0'));
    fs.writeFileSync(orphan, 'orphan');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(orphan, old, old);
    // The live document's file stays.
    const file = await hermes.call<WriteResult>('write', { space: 'shared', path: 'f.bin', content_base64: Buffer.from([1, 2, 3, 0]).toString('base64'), message: 'f' });
    const live = path.join(h.dataDir, 'blobs', file.doc!.content_hash.slice(0, 2), file.doc!.content_hash);
    fs.utimesSync(live, old, old);
    fs.writeFileSync(path.join(h.dataDir, 'backup.lock'), '');
    expect(janitor().orphanBlobs).toBe(0);
    expect(fs.existsSync(orphan)).toBe(true);
    fs.rmSync(path.join(h.dataDir, 'backup.lock'));
    expect(janitor().orphanBlobs).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });
});
