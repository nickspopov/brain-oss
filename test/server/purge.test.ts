// admin_purge: after the purge and `brain vacuum` the canary string is not in the DB bytes.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vacuum } from '../../src/core/backup.js';
import type { ExportResult, HistoryResult, ReadResult, WriteResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, RANDOM_ID, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

describe('admin_purge', () => {
  let h: Harness;
  let w: World;
  let claude: Client;
  let alice: Client;
  let canary: string;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, 'rest');
    claude = w.client('alice-assistant');
    alice = w.client('alice');
    canary = `Purgecanary${randomBytes(6).toString('hex')}`;
  });
  afterEach(async () => {
    expect(h.doctor()).toEqual({ ok: true, problems: [] });
    expect(h.auditedCalls()).toBe(h.opCalls());
    await h.close();
  });

  /** Bytes of the DB file and the WAL (if any), lowercased: FTS stores stems. */
  function dbBytes(): string {
    const files = ['brain.db', 'brain.db-wal'].map((f) => path.join(h.dataDir, f)).filter((f) => fs.existsSync(f));
    return files.map((f) => fs.readFileSync(f).toString('latin1')).join('').toLowerCase();
  }

  it('revision bodies: canary gone from the database file after purge and vacuum; purged revisions answer purged', async () => {
    const a = await claude.call<WriteResult>('write', { space: 'shared', path: 'leak.md', content: `# Leak\n\nkey ${canary}\n`, message: 'oops' });
    const id = a.doc!.id;
    await claude.call('write', { space: 'shared', path: 'leak.md', content: '# Leak\n\nremoved\n', expected_rev: 1, message: 'fix' });
    // Check that the canary really reached the DB file before the purge.
    h.core.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(dbBytes()).toContain(canary.toLowerCase());

    const out = await alice.call<{ scope: string; bodies_deleted: number }>('admin_purge', { id, revs: [1], reason: 'secret leak' });
    expect(out).toMatchObject({ scope: 'revisions', bodies_deleted: 1 });
    const hist = await claude.call<HistoryResult>('history', { id });
    expect(hist.revisions.find((r) => r.rev === 1)?.purged).toBe(true);
    for (const [op, input] of [
      ['read', { id, rev: 1 }],
      ['diff', { id, from: 1, to: 'head' }],
      ['revert', { id, to_rev: 1, expected_rev: 2, message: 'back' }],
    ] as const) {
      const r = await claude.raw(op, input);
      expect(r.status, op).toBe(410);
      expect(JSON.parse(r.text).error).toMatchObject({ code: 'purged', details: { rev: 1 } });
    }
    expect((await fetch(`${h.url}/api/v1/docs/${id}/raw?rev=1`, { headers: { authorization: `Bearer ${w.tokens['alice-assistant']}` } })).status).toBe(410);
    expect((await claude.call<ReadResult>('read', { id })).content).toBe('# Leak\n\nremoved\n');

    vacuum(h.core);
    expect(dbBytes()).not.toContain(canary.toLowerCase());
    // The audit recorded the reason, but not the content.
    const audit = h.core.db.prepare("SELECT detail FROM audit WHERE op = 'admin_purge'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ reason: 'secret leak', revs: [1] });
  });

  it('whole document: rows, history, index and bodies are gone; exports of the space dropped', async () => {
    const a = await claude.call<WriteResult>('write', {
      space: 'shared',
      path: `notes/${canary}.md`,
      content: `---\ntags: [${canary}]\n---\n# Title ${canary}\n\nbody ${canary}\n`,
      message: 'leak',
    });
    const id = a.doc!.id;
    await claude.call('write', { space: 'shared', path: `notes/${canary}.md`, content: `# T\n\nv2 ${canary}\n`, expected_rev: 1, message: 'v2' });
    const exp = await claude.call<ExportResult>('export', { space: 'shared', mode: 'full' });
    const out = await alice.call<{ scope: string; exports_dropped: number }>('admin_purge', { id, reason: 'leak' });
    expect(out).toMatchObject({ scope: 'document', exports_dropped: 1 });
    expect((await claude.raw('read', { id })).status).toBe(404);
    expect((await claude.raw('history', { id })).status).toBe(404);
    expect((await fetch(`${h.url}${exp.download_path}`, { headers: { authorization: `Bearer ${w.tokens['alice-assistant']}` } })).status).toBe(404);
    expect(fs.readdirSync(path.join(h.dataDir, 'tmp', 'exports'))).toEqual([]);
    vacuum(h.core);
    // Neither the write audit nor the search index (FTS after optimize) keeps the path or text of the purged revision.
    const audit = h.core.db.prepare('SELECT op, detail FROM audit WHERE detail LIKE ?').all(`%${canary}%`);
    expect(audit).toEqual([]);
    expect(dbBytes()).not.toContain(canary.toLowerCase());
  });

  it('refuses the head and revisions sharing the head body; checks visibility and the capability', async () => {
    const a = await claude.call<WriteResult>('write', { space: 'shared', path: 'h.md', content: '# H\n\nv1\n', message: 'v1' });
    const id = a.doc!.id;
    await claude.call('write', { space: 'shared', path: 'h.md', content: '# H\n\nv2\n', expected_rev: 1, message: 'v2' });
    await claude.call('revert', { id, to_rev: 1, message: 'back' });
    const head = await alice.raw('admin_purge', { id, revs: [3], reason: 'x' });
    expect(JSON.parse(head.text).error.details.reason).toBe('head_revision');
    const shared = await alice.raw('admin_purge', { id, revs: [1], reason: 'x' });
    expect(JSON.parse(shared.text).error.details.reason).toBe('head_body');
    expect((await alice.call<{ revs: number[] }>('admin_purge', { id, revs: [2, 2], reason: 'x' })).revs).toEqual([2]);
    // Purging the same revision again breaks nothing.
    expect((await alice.call<{ bodies_deleted: number }>('admin_purge', { id, revs: [2], reason: 'x' })).bodies_deleted).toBe(0);
    expect((await alice.raw('admin_purge', { id: RANDOM_ID, reason: 'x' })).status).toBe(404);
    // Without the capability there is no such operation; with it, only visible documents.
    const noop = await w.client('alphabot').raw('admin_purge', { id, reason: 'x' });
    expect(noop.text).toBe((await w.client('alphabot').raw('no_such_operation', {})).text);
    const beta = await w.client('betabot').call<WriteResult>('write', { space: 'proj-beta', path: 's.md', content: '# S\n', message: 's' });
    await alice.call('admin_principal_update', { name: 'alice-assistant', admin: true });
    const hidden = await claude.raw('admin_purge', { id: beta.doc!.id, reason: 'x' });
    expect(hidden.text).toBe((await claude.raw('admin_purge', { id: RANDOM_ID, reason: 'x' })).text);
    expect(JSON.parse((await claude.raw('admin_purge', { id, revs: [1], reason: 'x' })).text).error.details.reason).toBe('head_body');
  });
});
