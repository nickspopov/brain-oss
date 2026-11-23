// edit: anchored edits — exact replacement of a fragment, exactly one match.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryResult, ReadResult, WriteResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, RANDOM_ID, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const DOC = '# Plan\n\n## Alpha\n\nalpha text\n\n## Beta\n\nbeta text\n\nsame\nsame\n';

describe('edit', () => {
  let h: Harness;
  let w: World;
  let hermes: Client;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    hermes = w.client('alice-helper');
    alphabot = w.client('alphabot');
    await hermes.call('write', { space: 'shared', path: 'plan.md', content: DOC, message: 'create' });
  });
  afterEach(async () => {
    expect(h.doctor().problems).toEqual([]);
    await h.close();
  });

  const edit = (edits: { old_text: string; new_text: string }[], extra: Record<string, unknown> = {}) =>
    hermes.raw<WriteResult>('edit', { space: 'shared', path: 'plan.md', edits, message: 'edit', ...extra });
  const head = () => hermes.call<ReadResult>('read', { space: 'shared', path: 'plan.md' });

  it('replaces exact fragments in order and creates one revision', async () => {
    const r = await edit([
      { old_text: 'alpha text', new_text: 'alpha v2' },
      { old_text: 'alpha v2', new_text: 'alpha v3' },
      { old_text: '## Beta\n\nbeta text', new_text: '## Beta\n\nbeta v2' },
    ]);
    expect(r.body).toMatchObject({ ok: true, result: { status: 'committed', doc: { rev: 2 } } });
    const after = await head();
    expect(after.content).toBe(DOC.replace('alpha text', 'alpha v3').replace('beta text', 'beta v2'));
    expect(after.revision).toMatchObject({ kind: 'update', message: 'edit', author: { name: 'alice-helper' } });
    // The search index was updated in the same write.
    const found = await hermes.call<{ results: { doc: { path: string } }[] }>('search', { query: 'v3', spaces: ['shared'] });
    expect(found.results.map((x) => x.doc.path)).toEqual(['plan.md']);
  });

  it('by id works too; the doc is addressed like read', async () => {
    const { doc } = await head();
    const r = await hermes.call<WriteResult>('edit', { id: doc.id, edits: [{ old_text: 'beta text', new_text: 'by id' }], message: 'm' });
    expect(r.doc!.rev).toBe(2);
  });

  it('not_found and ambiguous anchors name the edit and nothing is applied', async () => {
    const missing = await edit([
      { old_text: 'alpha text', new_text: 'changed' },
      { old_text: 'no such text', new_text: 'x' },
    ]);
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ ok: false, error: { code: 'edit_failed', details: { edit_index: 1, reason: 'not_found' } } });
    const ambiguous = await edit([{ old_text: 'same', new_text: 'x' }]);
    expect(ambiguous.body).toMatchObject({ ok: false, error: { code: 'edit_failed', details: { edit_index: 0, reason: 'ambiguous', lines: [11, 12] } } });
    // An anchor that vanished because of an earlier edit in the same call is not_found too.
    const chained = await edit([
      { old_text: 'beta text', new_text: 'gone' },
      { old_text: 'beta text', new_text: 'again' },
    ]);
    expect(chained.body).toMatchObject({ ok: false, error: { details: { edit_index: 1, reason: 'not_found' } } });
    const after = await head();
    expect(after.content).toBe(DOC);
    expect(after.doc.rev).toBe(1);
  });

  it('expected_rev is optional; when passed it is checked', async () => {
    await edit([{ old_text: 'alpha text', new_text: 'a2' }]);
    const stale = await edit([{ old_text: 'beta text', new_text: 'b2' }], { expected_rev: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'stale', current: { rev: 2 } } } });
    const ok = await edit([{ old_text: 'beta text', new_text: 'b2' }], { expected_rev: 2 });
    expect(ok.body).toMatchObject({ ok: true, result: { doc: { rev: 3 } } });
  });

  it('a replacement that yields the same text is unchanged; CRLF in anchors is normalized', async () => {
    const same = await edit([{ old_text: 'alpha text', new_text: 'alpha text' }]);
    expect(same.body).toMatchObject({ ok: true, result: { unchanged: true, doc: { rev: 1 } } });
    const crlf = await edit([{ old_text: '## Alpha\r\n\r\nalpha text', new_text: '## Alpha\r\n\r\nline1\r\nline2' }]);
    expect(crlf.body).toMatchObject({ ok: true, result: { doc: { rev: 2 } } });
    expect((await head()).content).toContain('## Alpha\n\nline1\nline2\n');
  });

  it('request_id makes a retry return the stored response without a second revision', async () => {
    const input = { space: 'shared', path: 'plan.md', edits: [{ old_text: 'alpha text', new_text: 'once' }], message: 'm', request_id: 'edit-retry-0001' };
    const a = await hermes.call<WriteResult>('edit', input);
    const b = await hermes.call<WriteResult>('edit', input);
    expect(b).toEqual(a);
    const history = await hermes.call<HistoryResult>('history', { space: 'shared', path: 'plan.md' });
    expect(history.revisions).toHaveLength(2);
  });

  it('validation: empty old_text, more than 50 edits, unknown edit kinds', async () => {
    expect((await edit([{ old_text: '', new_text: 'x' }])).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => ({ old_text: `k${i}`, new_text: 'x' }));
    expect((await edit(many)).status).toBe(400);
    const r = await hermes.raw('edit', { space: 'shared', path: 'plan.md', edits: [{ append: 'x' }], message: 'm' });
    expect(r.status).toBe(400);
    expect((await hermes.raw('edit', { space: 'shared', path: 'plan.md', edits: [{ old_text: 'a', new_text: 'b' }] })).status).toBe(400);
  });

  it('files are unsupported; the result size is limited', async () => {
    await hermes.call('write', { space: 'shared', path: 'f.bin', content_base64: Buffer.from('binary data').toString('base64'), message: 'f' });
    const file = await hermes.raw('edit', { space: 'shared', path: 'f.bin', edits: [{ old_text: 'a', new_text: 'b' }], message: 'm' });
    expect(file.body).toMatchObject({ ok: false, error: { code: 'unsupported', details: { reason: 'not_text' } } });
    const big = await edit([{ old_text: 'alpha text', new_text: 'x'.repeat(520 * 1024) }]);
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ ok: false, error: { code: 'too_large', details: { limit: 512 * 1024 } } });
  });

  it('access: read-only → forbidden, hidden and missing → identical not_found', async () => {
    const ro = await alphabot.raw('edit', { space: 'shared', path: 'plan.md', edits: [{ old_text: 'alpha text', new_text: 'x' }], message: 'm' });
    expect(ro.body).toMatchObject({ ok: false, error: { code: 'forbidden', details: { required_role: 'propose' } } });
    await w.client('betabot').call('write', { space: 'proj-beta', path: 's.md', content: 'secret plan\n', message: 'c' });
    const hidden = await alphabot.raw('edit', { space: 'proj-beta', path: 's.md', edits: [{ old_text: 'secret plan', new_text: 'x' }], message: 'm' });
    const missing = await alphabot.raw('edit', { id: RANDOM_ID, edits: [{ old_text: 'secret plan', new_text: 'x' }], message: 'm' });
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).toBe(JSON.stringify(missing.body));
  });

  it('allow_secret is refused for an agent', async () => {
    const r = await edit([{ old_text: 'alpha text', new_text: 'x' }], { allow_secret: true });
    expect(r.body).toMatchObject({ ok: false, error: { code: 'invalid_input', details: { issues: [{ path: 'allow_secret' }] } } });
  });
});
