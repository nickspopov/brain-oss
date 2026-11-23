// The UI edit path over REST with a session: the same calls and headers that web/src/api/client.ts
// sends. Checks what the screens assume about the server: create with expected_rev 0, conflict with
// current and diff, history, diff, revert, move, trash and restore, file upload as bytes via PUT with
// a cookie.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWorld, ALICE_PASSWORD } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  buildWorld(h);
});
afterEach(async () => {
  await h.close();
});

const uiHeaders = () => ({ 'x-brain-client': 'brain-web', origin: h.config.origin, accept: 'application/json' });

async function login(): Promise<string> {
  const res = await fetch(`${h.url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { ...uiHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: ALICE_PASSWORD }),
  });
  expect(res.status).toBe(200);
  const m = /brain_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no cookie');
  return `brain_session=${m[1]}`;
}

type Env<T> = { ok: boolean; result: T; error?: { code: string; details?: Record<string, unknown> } };

async function op<T = Record<string, unknown>>(cookie: string, name: string, input: unknown = {}) {
  const res = await fetch(`${h.url}/api/v1/ops/${name}`, {
    method: 'POST',
    headers: { ...uiHeaders(), 'content-type': 'application/json', cookie },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as Env<T> };
}

async function put<T = Record<string, unknown>>(cookie: string, url: string, bytes: Uint8Array, headers: Record<string, string> = uiHeaders()) {
  const res = await fetch(`${h.url}${url}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', cookie }, body: bytes });
  return { status: res.status, body: (await res.json()) as Env<T> };
}

type Doc = { id: string; path: string; rev: number; deleted: boolean };

describe('UI edit path over REST with a session cookie', () => {
  it('create → stale conflict with current and diff → save over the current rev → history → diff → one-click revert', async () => {
    const cookie = await login();
    const ref = { space: 'handoff', path: 'plans/q4.md' };

    const created = await op<{ status: string; doc: Doc }>(cookie, 'write', { ...ref, content: '# Q4\n\nline 1\n', expected_rev: 0, message: 'Create', request_id: 'ui-create-0001' });
    expect(created.body.result).toMatchObject({ status: 'committed', doc: { rev: 1, path: 'plans/q4.md' } });
    // Replaying the same intent (network failure) does not write a second time.
    const again = await op<{ doc: Doc }>(cookie, 'write', { ...ref, content: '# Q4\n\nline 1\n', expected_rev: 0, message: 'Create', request_id: 'ui-create-0001' });
    expect(again.body.result.doc.rev).toBe(1);

    // Someone else saved rev 2 while the edit was open on rev 1.
    await op(cookie, 'write', { ...ref, content: '# Q4\n\nline 1\ntheir line\n', expected_rev: 1, message: 'another tab' });
    const stale = await op(cookie, 'write', { ...ref, content: '# Q4\n\nline 1\nmy line\n', expected_rev: 1, message: 'my edit' });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('conflict');
    const d = stale.body.error!.details!;
    expect(d.reason).toBe('stale');
    expect(d.current).toMatchObject({ rev: 2, content: '# Q4\n\nline 1\ntheir line\n', author: { name: 'alice' } });
    expect(String(d.diff)).toContain('+their line');

    // "Keep editing on top of revision 2" → save with expected_rev of the current one.
    const mine = await op<{ doc: Doc }>(cookie, 'write', { ...ref, content: '# Q4\n\nline 1\nmy line\n', expected_rev: 2, message: 'my edit' });
    expect(mine.body.result.doc.rev).toBe(3);

    const hist = await op<{ revisions: { rev: number; kind: string; message: string; via: string }[] }>(cookie, 'history', { ...ref, limit: 50 });
    expect(hist.body.result.revisions.map((r) => [r.rev, r.kind])).toEqual([
      [3, 'update'],
      [2, 'update'],
      [1, 'create'],
    ]);
    expect(hist.body.result.revisions[0]).toMatchObject({ message: 'my edit', via: 'ui' });

    const diff = await op<{ diff: string; added: number; removed: number }>(cookie, 'diff', { ...ref, from: 1, to: 3 });
    expect(diff.body.result).toMatchObject({ added: 1, removed: 0 });
    expect(diff.body.result.diff).toContain('+my line');

    const reverted = await op<{ status: string; doc: Doc }>(cookie, 'revert', { ...ref, to_rev: 1, expected_rev: 3, message: 'Revert to revision 1' });
    expect(reverted.body.result).toMatchObject({ status: 'committed', doc: { rev: 4 } });
    const head = await op<{ content: string; revision: { kind: string; ref_rev: number } }>(cookie, 'read', { ...ref, format: 'full' });
    expect(head.body.result.content).toBe('# Q4\n\nline 1\n');
    expect(head.body.result.revision).toMatchObject({ kind: 'revert', ref_rev: 1 });
    // A revert with a stale head is a conflict, not a blind write.
    expect((await op(cookie, 'revert', { ...ref, to_rev: 2, expected_rev: 3, message: 'x' })).body.error?.code).toBe('conflict');
  });

  it('move inside the space → delete → trash (list include_deleted, depth 5) → restore; a taken path asks for another', async () => {
    const cookie = await login();
    const w1 = await op<{ doc: Doc }>(cookie, 'write', { space: 'handoff', path: 'a/b/c/d/e/deep.md', content: 'deep\n', expected_rev: 0, message: 'm' });
    expect(w1.status).toBe(200);
    const w2 = await op<{ doc: Doc }>(cookie, 'write', { space: 'handoff', path: 'tmp.md', content: 'temporary\n', expected_rev: 0, message: 'm' });

    const moved = await op<{ doc: Doc }>(cookie, 'move', { space: 'handoff', path: 'tmp.md', to_path: 'old/tmp.md', expected_rev: 1, message: 'Move' });
    expect(moved.body.result.doc).toMatchObject({ path: 'old/tmp.md', rev: 2, id: w2.body.result.doc.id });

    for (const p of ['old/tmp.md', 'a/b/c/d/e/deep.md']) {
      const doc = (await op<{ doc: Doc }>(cookie, 'read', { space: 'handoff', path: p, format: 'meta' })).body.result.doc;
      expect((await op(cookie, 'delete', { space: 'handoff', path: p, expected_rev: doc.rev, message: 'Delete' })).status).toBe(200);
    }
    expect((await op(cookie, 'read', { space: 'handoff', path: 'old/tmp.md' })).body.error?.code).toBe('not_found');

    // Trash: depth 5 sees documents up to 5 levels deep; a folder at level 5 is listed separately.
    const top = await op<{ entries: ({ type: 'doc' } & Doc | { type: 'folder'; path: string })[] }>(cookie, 'list', {
      space: 'handoff',
      depth: 5,
      include_deleted: true,
      limit: 500,
    });
    const deleted = top.body.result.entries.filter((e): e is { type: 'doc' } & Doc => e.type === 'doc' && e.deleted).map((e) => e.path);
    expect(deleted).toContain('old/tmp.md');
    expect(top.body.result.entries).toContainEqual(expect.objectContaining({ type: 'folder', path: 'a/b/c/d/e' }));
    const deep = await op<{ entries: Doc[] }>(cookie, 'list', { space: 'handoff', path: 'a/b/c/d/e', depth: 5, include_deleted: true, limit: 500 });
    expect(deep.body.result.entries.map((e) => [e.path, e.deleted])).toEqual([['a/b/c/d/e/deep.md', true]]);
    // Without include_deleted the deleted document is absent.
    const live = await op<{ entries: { path: string }[] }>(cookie, 'list', { space: 'handoff', depth: 5, limit: 500 });
    expect(live.body.result.entries.map((e) => e.path)).not.toContain('old/tmp.md');

    // The path is taken by a new document → path_taken → restore to another path.
    await op(cookie, 'write', { space: 'handoff', path: 'old/tmp.md', content: 'new\n', expected_rev: 0, message: 'm' });
    const taken = await op(cookie, 'restore', { id: w2.body.result.doc.id, message: 'Restore from trash' });
    expect(taken.status).toBe(409);
    expect(taken.body.error?.details?.reason).toBe('path_taken');
    const restored = await op<{ doc: Doc }>(cookie, 'restore', { id: w2.body.result.doc.id, path: 'old/tmp-restored.md', message: 'Restore from trash' });
    expect(restored.body.result.doc).toMatchObject({ path: 'old/tmp-restored.md', deleted: false });
    const body = await op<{ content: string }>(cookie, 'read', { space: 'handoff', path: 'old/tmp-restored.md' });
    expect(body.body.result.content).toBe('temporary\n');
  });

  it('file upload: PUT bytes with the session; a taken path is replaced only with the current rev; no X-Brain-Client → refused', async () => {
    const cookie = await login();
    const pdf = new TextEncoder().encode('%PDF-1.4\n% test\n%%EOF\n');
    const url = '/api/v1/files/handoff/files/sc%C3%A1n.pdf?expected_rev=0&message=%C3%9Cbertragung&request_id=ui-upload-0001';
    const up = await put<{ status: string; doc: Doc & { kind: string; mime: string } }>(cookie, url, pdf);
    expect(up.status).toBe(200);
    expect(up.body.result).toMatchObject({ status: 'committed', doc: { path: 'files/scán.pdf', kind: 'file', mime: 'application/pdf', rev: 1 } });

    // Repeating the upload to the new path (expected_rev 0) → already_exists with the current revision.
    const v2 = new TextEncoder().encode('%PDF-1.4\n% version 2\n%%EOF\n');
    const exists = await put(cookie, '/api/v1/files/handoff/files/sc%C3%A1n.pdf?expected_rev=0', v2);
    expect(exists.status).toBe(409);
    expect(exists.body.error?.details).toMatchObject({ reason: 'already_exists', current: { rev: 1 } });
    const replaced = await put<{ doc: Doc }>(cookie, '/api/v1/files/handoff/files/sc%C3%A1n.pdf?expected_rev=1&message=v2', v2);
    expect(replaced.body.result.doc.rev).toBe(2);

    const raw = await fetch(`${h.url}/api/v1/docs/${up.body.result.doc.id}/raw`, { headers: { cookie } });
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(v2);

    const noClient = await put(cookie, '/api/v1/files/handoff/x.pdf?expected_rev=0', pdf, { origin: h.config.origin });
    expect(noClient.status).toBe(401);
  });
});
