// export full → new server → import restore yields the same tree, bodies and history;
// export head unpacks into a readable markdown tree.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportResult, HistoryResult, ListResult, ReadResult, WriteResult } from '../helpers/api.js';
import { ADAPTERS, makeClient, type AdapterName, type Client } from '../helpers/clients/index.js';
import { createSuperadmin } from '../../src/core/principals.js';
import { issueToken } from '../../src/core/tokens.js';
import { buildWorld, ALICE_PASSWORD, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { untar } from '../helpers/archive.js';

interface Snapshot {
  tree: string[];
  docs: Record<string, { content: string | undefined; kind: string; revisions: unknown[] }>;
}

/** Everything that must match after restore: tree, bodies, revisions (rev, kind, author, time, message, hash). */
async function snapshot(c: Client, space: string): Promise<Snapshot> {
  const list = await c.call<ListResult>('list', { space, depth: 5, include_deleted: true });
  const docs: Snapshot['docs'] = {};
  const tree: string[] = [];
  for (const e of list.entries) {
    if (e.type !== 'doc') continue;
    tree.push(`${e.path}${e.deleted ? ' (deleted)' : ''}`);
    const history = await c.call<HistoryResult>('history', { id: e.id, limit: 200 });
    const read = e.deleted ? undefined : await c.call<ReadResult>('read', { id: e.id });
    docs[e.id] = {
      kind: e.kind,
      content: read?.content,
      revisions: history.revisions.map((r) => ({
        rev: r.rev,
        kind: r.kind,
        author: r.author.name,
        created_at: r.created_at,
        message: r.message,
        content_hash: r.content_hash,
        path: r.path,
        prev_path: r.prev_path,
      })),
    };
  }
  return { tree: tree.sort(), docs };
}

describe.each(ADAPTERS)('a08 export/import via %s', (adapter: AdapterName) => {
  let h: Harness;
  let w: World;
  let claude: Client;
  let target: Harness | undefined;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, adapter);
    claude = w.client('alice-assistant');
  });
  afterEach(async () => {
    await h.close();
    await target?.close();
    target = undefined;
  });

  /** A space with edits, a move, a deletion, a revert and a file. */
  async function populate(): Promise<void> {
    const a = await claude.call<WriteResult>('write', { space: 'shared', path: 'guide/intro.md', content: '# Intro\n\nv1\n', message: 'intro v1' });
    await claude.call('write', { space: 'shared', path: 'guide/intro.md', content: '# Intro\n\nv2\n', expected_rev: 1, message: 'intro v2' });
    await w.client('alice-helper').call('write', { space: 'shared', path: 'guide/intro.md', content: '# Intro\n\nv3 by hermes\n', expected_rev: 2, message: 'intro v3' });
    await claude.call('revert', { id: a.doc!.id, to_rev: 1, message: 'back to v1' });
    const b = await claude.call<WriteResult>('write', { space: 'shared', path: 'drafts/b.md', content: '# B\n', message: 'b' });
    await claude.call('move', { id: b.doc!.id, to_path: 'final/b.md' });
    const c = await claude.call<WriteResult>('write', { space: 'shared', path: 'tmp/c.md', content: '# C\n', message: 'c' });
    await claude.call('delete', { id: c.doc!.id });
    await claude.call('write', {
      space: 'shared',
      path: 'assets/pixel.png',
      content_base64: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex').toString('base64'),
      message: 'file',
    });
  }

  async function download(token: string, path: string): Promise<Uint8Array> {
    const res = await fetch(`${h.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  }

  it('export full → fresh server → import restore: tree, bodies and every revision match; doctor clean', async () => {
    await populate();
    const before = await snapshot(claude, 'shared');
    const exp = await claude.call<ExportResult>('export', { space: 'shared', mode: 'full' });
    const archive = await download(w.tokens['alice-assistant'], exp.download_path);
    expect(archive.byteLength).toBe(exp.size);

    target = await startHarness();
    const tw = buildTargetAdmin(target);
    h.requireRoute('POST', '/api/v1/import');
    const res = await fetch(`${target.url}/api/v1/import?space=shared&mode=restore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tw.token}`, 'content-type': 'application/gzip' },
      body: archive,
    });
    expect(res.status).toBe(200);
    const after = await snapshot(makeClient(adapter, target, tw.token), 'shared');
    expect(after).toEqual(before);
    expect(target.doctor()).toEqual({ ok: true, problems: [] });
  });

  it('export head unpacks into a plain readable markdown tree', async () => {
    await populate();
    const exp = await claude.call<ExportResult>('export', { space: 'shared', mode: 'head' });
    const archive = await download(w.tokens['alice-assistant'], exp.download_path);
    const files = await untar(archive);
    expect(Object.keys(files).sort()).toEqual([
      'brain-export/manifest.json',
      'brain-export/tree/assets/pixel.png',
      'brain-export/tree/final/b.md',
      'brain-export/tree/guide/intro.md',
    ]);
    expect(files['brain-export/tree/guide/intro.md']).toBe('# Intro\n\nv1\n');
    const manifest = JSON.parse(files['brain-export/manifest.json']!) as { format: string; format_version: number; mode: string };
    expect(manifest).toMatchObject({ format: 'brain-export', format_version: 1, mode: 'head' });
  });

  it('export is deterministic and changes nothing', async () => {
    await populate();
    const dump = () => JSON.stringify(h.core.db.prepare('SELECT * FROM revisions ORDER BY seq').all());
    const before = dump();
    const e1 = await claude.call<ExportResult>('export', { space: 'shared', mode: 'full', at: new Date(h.clock.now()).toISOString() });
    const e2 = await claude.call<ExportResult>('export', { space: 'shared', mode: 'full', at: new Date(h.clock.now()).toISOString() });
    expect(e1.sha256).toBe(e2.sha256);
    expect(dump()).toBe(before);
  });
});

/** A new empty server: only the superadmin and its token; there is no shared space (restore mode). */
function buildTargetAdmin(t: Harness): { token: string } {
  const alice = createSuperadmin(t.core, 'alice', ALICE_PASSWORD);
  return { token: issueToken(t.core, alice.id).token };
}
