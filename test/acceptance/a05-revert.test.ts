// Revert, undo, delete and restore create new revisions;
// earlier revisions do not change.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryResult, ListResult, ReadResult, SearchResult, WriteResult } from '../helpers/api.js';
import { ADAPTERS, type AdapterName, type Client } from '../helpers/clients/index.js';
import { hasOp } from '../../src/ops/registry.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { pending } from '../helpers/pending.js';

describe.each(ADAPTERS)('a05 revert via %s', (adapter: AdapterName) => {
  let h: Harness;
  let w: World;
  let hermes: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, adapter);
    hermes = w.client('alice-helper');
  });
  afterEach(async () => {
    // One audit line per operation call made by the scenario.
    expect(h.auditedCalls()).toBe(h.opCalls());
    await h.close();
  });

  const dumpRevisions = () => h.core.db.prepare('SELECT * FROM revisions ORDER BY seq').all() as Record<string, unknown>[];

  async function threeVersions(): Promise<string> {
    const v1 = await hermes.call<WriteResult>('write', { space: 'shared', path: 'doc.md', content: 'line one\nline two\nline three\n', message: 'v1' });
    await hermes.call('write', { space: 'shared', path: 'doc.md', content: 'line one\nline TWO\nline three\n', expected_rev: 1, message: 'v2' });
    await hermes.call('write', { space: 'shared', path: 'doc.md', content: 'line one\nline TWO\nline three\nline four\n', expected_rev: 2, message: 'v3' });
    return v1.doc!.id;
  }

  it('revert creates a new revision; earlier revisions stay and are readable by rev', async () => {
    const id = await threeVersions();
    const before = dumpRevisions();
    const r = await hermes.call<WriteResult>('revert', { id, to_rev: 1, expected_rev: 3, message: 'back to v1' });
    expect(r.status).toBe('committed');
    expect(r.doc!.rev).toBe(4);
    const head = await hermes.call<ReadResult>('read', { id });
    expect(head.content).toBe('line one\nline two\nline three\n');
    expect(head.revision.kind).toBe('revert');
    expect(head.revision.ref_rev).toBe(1);
    for (const [rev, text] of [
      [1, 'line one\nline two\nline three\n'],
      [2, 'line one\nline TWO\nline three\n'],
      [3, 'line one\nline TWO\nline three\nline four\n'],
    ] as const) {
      expect((await hermes.call<ReadResult>('read', { id, rev })).content).toBe(text);
    }
    expect(dumpRevisions().slice(0, before.length)).toEqual(before);
    const history = await hermes.call<HistoryResult>('history', { id });
    expect(history.revisions.map((x) => [x.rev, x.kind])).toEqual([[4, 'revert'], [3, 'update'], [2, 'update'], [1, 'create']]);
  });

  // Patch-based `undo` is cut from v1 (revert remains). The scenarios are kept unchanged:
  // while the operation is missing they count as expected failures; if undo arrives (v2), remove the marker.
  pending('v2 (undo is cut from v1)', 'undo of one revision applies its reverse patch on top of the head', async () => {
    const id = await threeVersions();
    const before = dumpRevisions();
    const r = await hermes.call<WriteResult>('undo', { id, rev: 2, message: 'undo TWO' });
    expect(r.status).toBe('committed');
    const head = await hermes.call<ReadResult>('read', { id });
    expect(head.content).toBe('line one\nline two\nline three\nline four\n');
    expect(head.revision.kind).toBe('undo');
    expect(head.revision.ref_rev).toBe(2);
    expect(dumpRevisions().slice(0, before.length)).toEqual(before);
  });

  pending('v2 (undo is cut from v1)', 'undo that overlaps later edits → conflict undo_overlap, nothing written', async () => {
    const id = await threeVersions();
    await hermes.call('write', { space: 'shared', path: 'doc.md', content: 'line one\nline 2!\nline three\nline four\n', expected_rev: 3, message: 'v4' });
    const before = dumpRevisions();
    const r = await hermes.raw('undo', { id, rev: 2, message: 'undo TWO' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'undo_overlap' } } });
    expect(dumpRevisions()).toEqual(before);
  });

  it('delete hides the document from list and search; restore brings it back with history', async () => {
    const id = await threeVersions();
    const before = dumpRevisions();
    const del = await hermes.call<{ doc: { deleted: boolean; rev: number } }>('delete', { id });
    expect(del.doc.deleted).toBe(true);
    expect(del.doc.rev).toBe(4);
    const list = await hermes.call<ListResult>('list', { space: 'shared' });
    expect(list.entries.map((e) => e.path)).not.toContain('doc.md');
    const trash = await hermes.call<ListResult>('list', { space: 'shared', include_deleted: true });
    expect(trash.entries.map((e) => e.path)).toContain('doc.md');
    // This part of the scenario runs as soon as the search operation exists.
    if (hasOp('search')) {
      const found = await hermes.call<SearchResult>('search', { query: 'line four' });
      expect(found.results.map((x) => x.doc.id)).not.toContain(id);
    }
    // The path is free: a new document at the same path gets a new id.
    const fresh = await hermes.call<WriteResult>('write', { space: 'shared', path: 'doc.md', content: 'new\n', message: 'new doc' });
    expect(fresh.doc!.id).not.toBe(id);
    // The path is taken → conflict path_taken; restoring under another path works.
    const taken = await hermes.raw('restore', { id });
    expect(taken.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'path_taken' } } });
    const restored = await hermes.call<{ doc: { deleted: boolean; path: string; rev: number } }>('restore', { id, path: 'doc-restored.md' });
    expect(restored.doc).toMatchObject({ deleted: false, path: 'doc-restored.md', rev: 5 });
    const history = await hermes.call<HistoryResult>('history', { id });
    expect(history.revisions.map((x) => x.kind)).toEqual(['restore', 'delete', 'update', 'update', 'create']);
    expect((await hermes.call<ReadResult>('read', { id })).content).toBe('line one\nline TWO\nline three\nline four\n');
    expect(dumpRevisions().slice(0, before.length)).toEqual(before);
  });

  it('revert of a deleted document restores it first', async () => {
    const id = await threeVersions();
    await hermes.call('delete', { id });
    const r = await hermes.call<WriteResult>('revert', { id, to_rev: 1, message: 'resurrect v1' });
    expect(r.status).toBe('committed');
    const history = await hermes.call<HistoryResult>('history', { id });
    expect(history.revisions.slice(0, 2).map((x) => x.kind)).toEqual(['revert', 'restore']);
    expect((await hermes.call<ReadResult>('read', { id })).content).toBe('line one\nline two\nline three\n');
  });
});
