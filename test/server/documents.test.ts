// Documents and revisions over REST.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConflictDetails, HistoryResult, ListResult, ReadResult, WriteResult } from '../helpers/api.js';
import type { Client, RawResponse } from '../helpers/clients/index.js';
import { buildWorld, RANDOM_ID, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const shape = (r: RawResponse) => JSON.stringify({ status: r.status, body: r.body });

async function expectCode(p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code, ...(details ? { details } : {}) });
}

describe('documents', () => {
  let h: Harness;
  let w: World;
  let hermes: Client;
  let claude: Client;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    hermes = w.client('alice-helper');
    claude = w.client('alice-assistant');
    alphabot = w.client('alphabot');
  });
  afterEach(async () => {
    expect(h.doctor().problems).toEqual([]);
    await h.close();
  });

  const write = (c: Client, path: string, content: string, extra: Record<string, unknown> = {}) =>
    c.call<WriteResult>('write', { space: 'shared', path, content, message: `write ${path}`, ...extra });

  describe('write and read', () => {
    it('creates a document with metadata from frontmatter; read returns author, trust, trust_floor', async () => {
      const content = '---\ntitle: The Plan\ntags: [plan, q4]\n---\n# Heading\n\nBody.\n';
      const r = await write(hermes, 'plans/plan.md', content);
      expect(r.status).toBe('committed');
      expect(r.doc).toMatchObject({
        space: 'shared',
        path: 'plans/plan.md',
        kind: 'text',
        mime: 'text/markdown',
        title: 'The Plan',
        tags: ['plan', 'q4'],
        rev: 1,
        content_hash: sha(content),
        size: Buffer.byteLength(content),
        author: { name: 'alice-helper', kind: 'agent', trust: 'trusted' },
        trust_floor: 'trusted',
        deleted: false,
      });
      expect(r.warnings).toBeUndefined();
      const read = await alphabot.call<ReadResult>('read', { space: 'shared', path: 'plans/plan.md' });
      expect(read.content).toBe(content);
      expect(read.encoding).toBe('utf8');
      expect(read.truncated).toBe(false);
      expect(read.revision).toMatchObject({ rev: 1, kind: 'create', via: 'rest', message: 'write plans/plan.md', purged: false, attention: false });
      expect((await alphabot.call<ReadResult>('read', { id: r.doc!.id })).doc).toEqual(read.doc);
    });

    it('CRLF becomes LF; NUL is rejected; invalid frontmatter only warns', async () => {
      const r = await write(hermes, 'crlf.md', 'a\r\nb\r');
      expect((await hermes.call<ReadResult>('read', { id: r.doc!.id })).content).toBe('a\nb\n');
      await expectCode(write(hermes, 'nul.md', 'a\u0000b'), 'invalid_input');
      const bad = await write(hermes, 'bad.md', '---\ntitle: [oops\n---\n# T\n');
      expect(bad.status).toBe('committed');
      expect(bad.warnings).toEqual(['frontmatter_invalid']);
      expect(bad.doc!.title).toBe('T');
    });

    it('write outcomes: create, expected_rev_required, already_exists, not_found_at_rev, stale with current and diff', async () => {
      await write(hermes, 'c.md', 'one\ntwo\n');
      await expectCode(write(hermes, 'c.md', 'x\n'), 'conflict', { reason: 'expected_rev_required' });
      await expectCode(write(hermes, 'c.md', 'x\n', { expected_rev: 0 }), 'conflict', { reason: 'already_exists' });
      await expectCode(write(hermes, 'nope.md', 'x\n', { expected_rev: 2 }), 'conflict', { reason: 'not_found_at_rev' });
      await write(claude, 'c.md', 'one\nTWO\n', { expected_rev: 1 });
      const r = await hermes.raw('write', { space: 'shared', path: 'c.md', content: 'mine\n', expected_rev: 1, message: 'm' });
      expect(r.status).toBe(409);
      const d = (r.body as unknown as { error: { details: ConflictDetails } }).error.details;
      expect(d.reason).toBe('stale');
      expect(d.current).toMatchObject({ rev: 2, content: 'one\nTWO\n', author: { name: 'alice-assistant', trust: 'admin' }, content_hash: sha('one\nTWO\n') });
      expect(d.diff).toContain('-two');
      expect(d.diff).toContain('+TWO');
      expect(r.text).not.toContain('mine');
    });

    it('a write with the same content is unchanged and creates no revision', async () => {
      const a = await write(hermes, 'u.md', 'same\n');
      const b = await write(hermes, 'u.md', 'same\n', { expected_rev: 1 });
      expect(b).toMatchObject({ status: 'committed', unchanged: true, doc: { rev: 1 } });
      expect(b.doc).toEqual(a.doc);
      expect((await hermes.call<HistoryResult>('history', { space: 'shared', path: 'u.md' })).revisions).toHaveLength(1);
    });

    it('size limit of a text document → too_large with limit and actual', async () => {
      const big = await startHarness({ env: { BRAIN_MAX_DOC_KB: '1' } });
      try {
        const bw = buildWorld(big);
        const r = await bw.client('alice-helper').raw('write', { space: 'shared', path: 'big.md', content: 'x'.repeat(2000), message: 'big' });
        expect(r.status).toBe(413);
        expect(r.body).toMatchObject({ ok: false, error: { code: 'too_large', details: { limit: 1024, actual: 2000 } } });
      } finally {
        await big.close();
      }
    });

    it('read: past revision, outline, meta, chunks by offset and max_bytes', async () => {
      const v1 = '# One\n\n## Sub\n\ntext\n';
      const r = await write(hermes, 'r.md', v1);
      await write(hermes, 'r.md', 'ωωωωωωωω🧠🧠\n', { expected_rev: 1 });
      const id = r.doc!.id;
      expect((await hermes.call<ReadResult>('read', { id, rev: 1 })).content).toBe(v1);
      const outline = await hermes.call<ReadResult & { outline: unknown }>('read', { id, rev: 1, format: 'outline' });
      expect(outline.content).toBeUndefined();
      expect(outline.outline).toEqual([
        { level: 1, text: 'One', line: 1 },
        { level: 2, text: 'Sub', line: 3 },
      ]);
      const meta = await hermes.call<ReadResult>('read', { id, format: 'meta' });
      expect(meta.content).toBeUndefined();
      expect(meta.revision.rev).toBe(2);
      let text = '';
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const part: ReadResult = await hermes.call<ReadResult>('read', { id, offset, max_bytes: 5 });
        text += part.content;
        expect(part.truncated).toBe(part.next_offset !== undefined);
        offset = part.next_offset;
      }
      expect(text).toBe('ωωωωωωωω🧠🧠\n');
      await expectCode(hermes.call('read', { id, rev: 9 }), 'not_found');
    });

    it('a full read of the head counts in read_count', async () => {
      const r = await write(hermes, 'rc.md', 'x\n');
      await alphabot.call('read', { id: r.doc!.id });
      await alphabot.call('read', { id: r.doc!.id, format: 'meta' });
      const row = h.core.db.prepare('SELECT read_count FROM documents WHERE id = ?').get(r.doc!.id) as { read_count: number };
      expect(row.read_count).toBe(1);
    });

    it('a binary file through content_base64: kind file, MIME by signature, bytes round-trip', async () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('payload')]);
      const r = await hermes.call<WriteResult>('write', { space: 'shared', path: 'img/logo.txt', content_base64: png.toString('base64'), message: 'logo' });
      expect(r.doc).toMatchObject({ kind: 'file', mime: 'image/png', size: png.length, content_hash: sha(png), title: 'logo.txt' });
      const read = await hermes.call<ReadResult>('read', { id: r.doc!.id });
      expect(read.encoding).toBe('base64');
      expect(Buffer.from(read.content!, 'base64')).toEqual(png);
      await expectCode(hermes.call('write', { space: 'shared', path: 'img/logo.txt', content: 'text', expected_rev: 1, message: 'x' }), 'unsupported', {
        reason: 'kind_mismatch',
      });
      await expectCode(hermes.call('diff', { id: r.doc!.id, from: 1 }), 'unsupported');
      await expectCode(hermes.call('write', { space: 'shared', path: 'x.bin', content: 'a', content_base64: 'YQ==', message: 'x' }), 'invalid_input');
    });
  });

  describe('rights', () => {
    it('read-only role → forbidden; hidden space and missing space → identical not_found', async () => {
      await expectCode(write(alphabot, 'f.md', 'x\n'), 'forbidden', { required_role: 'propose' });
      const hidden = await alphabot.raw('write', { space: 'proj-beta', path: 'a.md', content: 'x\n', message: 'x' });
      const missing = await alphabot.raw('write', { space: 'no-such-space', path: 'a.md', content: 'x\n', message: 'x' });
      expect(shape(hidden)).toBe(shape(missing));
      expect(hidden.status).toBe(404);
      const doc = await w.client('betabot').call<WriteResult>('write', { space: 'proj-beta', path: 's.md', content: 'x\n', message: 'x' });
      for (const op of ['read', 'history', 'delete']) {
        expect(shape(await alphabot.raw(op, { id: doc.doc!.id }))).toBe(shape(await alphabot.raw(op, { id: RANDOM_ID })));
      }
      expect(shape(await alphabot.raw('diff', { id: doc.doc!.id, from: 1 }))).toBe(shape(await alphabot.raw('diff', { id: RANDOM_ID, from: 1 })));
      expect(shape(await alphabot.raw('restore', { id: doc.doc!.id }))).toBe(shape(await alphabot.raw('restore', { id: RANDOM_ID })));
    });

    it('protected path: non-admin write → proposal; space admin writes', async () => {
      await w.client('alice').call('admin_space_update', { slug: 'shared', protected_paths: ['AGENTS.md'] });
      const p = await write(hermes, 'AGENTS.md', '# Rules\n');
      expect(p.status).toBe('proposed');
      expect(p.doc).toBeUndefined();
      expect((await write(claude, 'AGENTS.md', '# Rules\n')).status).toBe('committed');
    });

    it('role propose → the write becomes a proposal', async () => {
      w.grant('shared', { principal: 'alphabot' }, 'propose');
      const p = await write(alphabot, 'p.md', 'x\n');
      expect(p).toMatchObject({ status: 'proposed', proposal: { status: 'open', path: 'p.md', base_rev: 0 } });
      await expectCode(alphabot.call('read', { space: 'shared', path: 'p.md' }), 'not_found');
    });

    it('executable space: a revision by a non-admin author is marked attention, by an admin author not', async () => {
      w.grant('recipes', { principal: 'alice-helper' }, 'write');
      const a = await hermes.call<WriteResult>('write', { space: 'recipes', path: 'r.md', content: 'x\n', message: 'x' });
      const b = await claude.call<WriteResult>('write', { space: 'recipes', path: 'r2.md', content: 'x\n', message: 'x' });
      expect((await claude.call<ReadResult>('read', { id: a.doc!.id })).revision.attention).toBe(true);
      expect((await claude.call<ReadResult>('read', { id: b.doc!.id })).revision.attention).toBe(false);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      for (const p of ['b.md', 'A.md', 'docs/x.md', 'docs/deep/y.md', 'docs/deep/z.md', 'private/secret.md']) await write(hermes, p, `# ${p}\n`);
    });

    it('folders first, then documents, by path_key; children count direct visible children', async () => {
      const root = await hermes.call<ListResult>('list', { space: 'shared' });
      expect(root.entries.map((e) => [e.type, e.path])).toEqual([
        ['folder', 'docs'],
        ['folder', 'private'],
        ['doc', 'A.md'],
        ['doc', 'b.md'],
      ]);
      expect(root.entries[0]).toMatchObject({ children: 2 });
      const deep = await hermes.call<ListResult>('list', { space: 'shared', path: 'docs', depth: 5 });
      expect(deep.entries.map((e) => e.path)).toEqual(['docs/deep', 'docs/deep/y.md', 'docs/deep/z.md', 'docs/x.md']);
      await expectCode(hermes.call('list', { space: 'shared', path: 'nothing-here' }), 'not_found');
    });

    it('a folder closed by narrow none disappears together with its counters', async () => {
      w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'private/' });
      w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'docs/deep/' });
      const root = await alphabot.call<ListResult>('list', { space: 'shared', depth: 5 });
      expect(root.entries.map((e) => e.path)).toEqual(['docs', 'A.md', 'b.md', 'docs/x.md']);
      expect(root.entries[0]).toMatchObject({ children: 1 });
      expect(shape(await alphabot.raw('list', { space: 'shared', path: 'private' }))).toBe(shape(await alphabot.raw('list', { space: 'shared', path: 'nothing' })));
    });

    it('paginates with a cursor', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page: ListResult = await hermes.call<ListResult>('list', { space: 'shared', depth: 5, limit: 2, ...(cursor ? { cursor } : {}) });
        expect(page.entries.length).toBeLessThanOrEqual(2);
        seen.push(...page.entries.map((e) => e.path));
        cursor = page.next_cursor;
      } while (cursor);
      const all = await hermes.call<ListResult>('list', { space: 'shared', depth: 5 });
      expect(seen).toEqual(all.entries.map((e) => e.path));
      await expectCode(hermes.call('list', { space: 'shared', cursor: 'garbage' }), 'invalid_input');
    });
  });

  describe('history and diff', () => {
    it('history is newest first and paginates', async () => {
      const r = await write(hermes, 'h.md', 'v1\n');
      for (let i = 2; i <= 5; i++) await write(hermes, 'h.md', `v${i}\n`, { expected_rev: i - 1 });
      const revs: number[] = [];
      let cursor: string | undefined;
      do {
        const page: HistoryResult = await hermes.call<HistoryResult>('history', { id: r.doc!.id, limit: 2, ...(cursor ? { cursor } : {}) });
        revs.push(...page.revisions.map((x) => x.rev));
        cursor = page.next_cursor;
      } while (cursor);
      expect(revs).toEqual([5, 4, 3, 2, 1]);
    });

    it('diff unified and stat', async () => {
      const r = await write(hermes, 'd.md', 'a\nb\nc\n');
      await write(hermes, 'd.md', 'a\nB\nc\nd\n', { expected_rev: 1 });
      const u = await hermes.call<{ diff: string; added: number; removed: number; from: number; to: number }>('diff', { id: r.doc!.id, from: 1 });
      expect(u).toMatchObject({ from: 1, to: 2, added: 2, removed: 1, truncated: false });
      expect(u.diff).toContain('-b\n+B');
      const s = await hermes.call<{ diff?: string }>('diff', { id: r.doc!.id, from: 2, to: 1, format: 'stat' });
      expect(s).toMatchObject({ from: 2, to: 1, added: 1, removed: 2 });
      expect(s.diff).toBeUndefined();
    });
  });

  describe('move', () => {
    it('renames within the space with a move revision; the id and history stay', async () => {
      const r = await write(hermes, 'old/name.md', '# N\n');
      const m = await hermes.call<{ doc: { id: string; path: string; rev: number } }>('move', { id: r.doc!.id, to_path: 'new/name.md' });
      expect(m.doc).toMatchObject({ id: r.doc!.id, path: 'new/name.md', rev: 2 });
      const hist = await hermes.call<HistoryResult>('history', { id: r.doc!.id });
      expect(hist.revisions[0]).toMatchObject({ kind: 'move', path: 'new/name.md', prev_path: 'old/name.md' });
      await expectCode(hermes.call('read', { space: 'shared', path: 'old/name.md' }), 'not_found');
      const caseOnly = await hermes.call<{ doc: { path: string } }>('move', { id: r.doc!.id, to_path: 'new/Name.md' });
      expect(caseOnly.doc.path).toBe('new/Name.md');
    });

    it('path_taken, cross-space move and folder move are rejected', async () => {
      const a = await write(hermes, 'a.md', 'a\n');
      await write(hermes, 'b.md', 'b\n');
      await expectCode(hermes.call('move', { id: a.doc!.id, to_path: 'B.md' }), 'conflict', { reason: 'path_taken' });
      await expectCode(hermes.call('move', { id: a.doc!.id, to_space: 'handoff', to_path: 'a.md' }), 'invalid_input');
      await expectCode(hermes.call('move', { space: 'shared', path: 'a.md', to_path: 'folder/' }), 'invalid_input');
      expect((await hermes.call<{ doc: { rev: number } }>('move', { id: a.doc!.id, to_space: 'shared', to_path: 'c.md' })).doc.rev).toBe(2);
    });

    it('needs write on the target; a former path in a closed folder is hidden in history', async () => {
      w.grant('shared', { principal: 'alphabot' }, 'write', { path: 'open/' });
      w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'closed/' });
      const r = await write(hermes, 'closed/zqhiddenname.md', 'x\n', { message: 'note' });
      await hermes.call('move', { id: r.doc!.id, to_path: 'open/visible.md' });
      const hist = await alphabot.raw('history', { id: r.doc!.id });
      expect(hist.status).toBe(200);
      expect(hist.text).not.toContain('zqhiddenname');
      const mine = await alphabot.call<WriteResult>('write', { space: 'shared', path: 'open/mine.md', content: 'x\n', message: 'x' });
      await expectCode(alphabot.call('move', { id: mine.doc!.id, to_path: 'elsewhere.md' }), 'forbidden');
      await expectCode(alphabot.call('move', { id: mine.doc!.id, to_path: 'closed/x.md' }), 'not_found');
    });
  });

  describe('delete, restore, revert', () => {
    it('restore goes through review routing for the target path', async () => {
      const r = await write(hermes, 'notes.md', 'x\n');
      await hermes.call('delete', { id: r.doc!.id });
      await w.client('alice').call('admin_space_update', { slug: 'shared', protected_paths: ['AGENTS.md'] });
      await expectCode(hermes.call('restore', { id: r.doc!.id, path: 'AGENTS.md' }), 'forbidden', { reason: 'review_required' });
      await expectCode(hermes.call('restore', { id: RANDOM_ID }), 'not_found');
      expect((await hermes.call<{ doc: { path: string } }>('restore', { id: r.doc!.id })).doc.path).toBe('notes.md');
      await expectCode(hermes.call('restore', { id: r.doc!.id }), 'conflict', { reason: 'not_deleted' });
    });

    it('delete with a stale expected_rev → conflict; revert to the head body is unchanged', async () => {
      const r = await write(hermes, 'x.md', 'one\n');
      await write(hermes, 'x.md', 'two\n', { expected_rev: 1 });
      await expectCode(hermes.call('delete', { id: r.doc!.id, expected_rev: 1 }), 'conflict', { reason: 'stale' });
      const same = await hermes.call<WriteResult>('revert', { id: r.doc!.id, to_rev: 2, message: 'noop' });
      expect(same).toMatchObject({ status: 'committed', unchanged: true, doc: { rev: 2 } });
      await expectCode(hermes.call('revert', { id: r.doc!.id, to_rev: 7, message: 'x' }), 'not_found');
    });

    it('bytes_used follows the heads of live documents', async () => {
      const used = () => (h.core.db.prepare("SELECT bytes_used FROM spaces WHERE slug = 'shared'").get() as { bytes_used: number }).bytes_used;
      const r = await write(hermes, 'q.md', '12345');
      expect(used()).toBe(5);
      await write(hermes, 'q.md', '12', { expected_rev: 1 });
      expect(used()).toBe(2);
      await hermes.call('delete', { id: r.doc!.id });
      expect(used()).toBe(0);
      await hermes.call('restore', { id: r.doc!.id });
      expect(used()).toBe(2);
    });
  });

  describe('idempotency', () => {
    it('a replay re-checks the current access; another operation with the same request_id → mismatch', async () => {
      const input = { space: 'shared', path: 'idem.md', content: 'x\n', message: 'x', request_id: 'req-idem-0001' };
      const first = await hermes.call<WriteResult>('write', input);
      expect(await hermes.call<WriteResult>('write', input)).toEqual(first);
      await expectCode(hermes.call('delete', { id: first.doc!.id, request_id: 'req-idem-0001' }), 'idempotency_mismatch');
      w.grant('shared', { principal: 'alice-helper' }, 'none', { docId: first.doc!.id });
      const replay = await hermes.raw('write', input);
      expect(shape(replay)).toBe(shape(await hermes.raw('read', { id: RANDOM_ID })));
      const n = h.core.db.prepare('SELECT count(*) AS n FROM revisions WHERE doc_id = ?').get(first.doc!.id) as { n: number };
      expect(n.n).toBe(1);
    });

    it('every write is audited once with its document and revision, replays too', async () => {
      const input = { space: 'shared', path: 'aud.md', content: 'x\n', message: 'x', request_id: 'req-audit-001' };
      const r = await hermes.call<WriteResult>('write', input);
      await hermes.call('write', input);
      const rows = h.core.db
        .prepare("SELECT op, outcome, doc_id, rev, detail FROM audit WHERE op = 'write' ORDER BY id")
        .all() as { outcome: string; doc_id: string | null; rev: number | null; detail: string | null }[];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ outcome: 'ok', doc_id: r.doc!.id, rev: 1 });
      expect(rows[1]).toMatchObject({ outcome: 'ok', detail: '{"replay":true}' });
    });
  });

  describe('spaces.agents_md', () => {
    it('is returned only with read on AGENTS.md itself', async () => {
      await write(claude, 'AGENTS.md', '# Shared rules\n');
      const agentsOf = async (c: Client) =>
        (await c.call<{ spaces: { slug: string; agents_md?: { rev: number; content: string; truncated: boolean } }[] }>('spaces')).spaces.find(
          (s) => s.slug === 'shared',
        )?.agents_md;
      expect(await agentsOf(alphabot)).toEqual({ rev: 1, content: '# Shared rules\n', truncated: false });
      const doc = await alphabot.call<ReadResult>('read', { space: 'shared', path: 'AGENTS.md' });
      w.grant('shared', { principal: 'alphabot' }, 'none', { docId: doc.doc.id });
      expect(await agentsOf(alphabot)).toBeUndefined();
      expect(await agentsOf(hermes)).toBeDefined();
    });
  });

  describe('doctor', () => {
    it('reports a Yjs body that differs from the head', async () => {
      const r = await write(hermes, 'y.md', 'one\n');
      await write(hermes, 'y.md', 'two\n', { expected_rev: 1 });
      expect(h.doctor().ok).toBe(true);
      const old = h.core.db.prepare('SELECT state FROM doc_ystate WHERE doc_id = ?').get(r.doc!.id) as { state: Buffer };
      const { applyText } = await import('../../src/core/ydoc/body.js');
      h.core.db.prepare('UPDATE doc_ystate SET state = ? WHERE doc_id = ?').run(Buffer.from(applyText(null, 'tampered\n')), r.doc!.id);
      expect(h.doctor().problems.join('\n')).toContain('Yjs text differs');
      h.core.db.prepare('UPDATE doc_ystate SET state = ? WHERE doc_id = ?').run(old.state, r.doc!.id);
    });
  });
});
