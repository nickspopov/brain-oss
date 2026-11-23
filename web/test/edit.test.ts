// Editing helpers: request_id, conflict, diff, paths, file upload, trash.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setFetch } from '../src/api/client';
import { asConflict, diffLines, diffTexts, hasChanges, joinPath, pathProblem, requestIdFor, folderOf } from '../src/lib/edit';
import { routes } from '../src/lib/routes';
import { loadTrash } from '../src/pages/TrashPage';

afterEach(() => setFetch((...a) => fetch(...a)));

describe('request_id', () => {
  it('the same intent keeps its id (safe retry after a network failure), another intent gets a new one', () => {
    const idFor = requestIdFor();
    const a = idFor({ content: 'x', expected_rev: 1 });
    expect(a).toMatch(/^ui-[0-9a-f]{32}$/);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(idFor({ content: 'x', expected_rev: 1 })).toBe(a);
    const b = idFor({ content: 'x', expected_rev: 2 });
    expect(b).not.toBe(a);
    expect(idFor({ content: 'x', expected_rev: 1 })).not.toBe(a);
    expect(requestIdFor()({ content: 'x', expected_rev: 1 })).not.toBe(a);
  });

  it('run keeps the id after a failure and forgets it after a success', async () => {
    const idFor = requestIdFor();
    const seen: string[] = [];
    await expect(idFor.run({ name: 'a' }, async (id) => (seen.push(id), Promise.reject(new TypeError('network'))))).rejects.toThrow('network');
    await idFor.run({ name: 'a' }, async (id) => seen.push(id));
    await idFor.run({ name: 'a' }, async (id) => seen.push(id));
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[1]);
  });
});

describe('conflict', () => {
  it('reads reason, current and diff from the error envelope', () => {
    const err = new ApiError(409, {
      code: 'conflict',
      message: 'c',
      retryable: false,
      details: { reason: 'stale', current: { rev: 5, content_hash: 'h', author: { name: 'a', kind: 'agent', trust: 'limited' }, updated_at: 't', content: 'x' }, diff: '@@' },
    });
    expect(asConflict(err)).toEqual({ reason: 'stale', current: expect.objectContaining({ rev: 5, content: 'x' }), diff: '@@' });
    expect(asConflict(new ApiError(409, { code: 'conflict', message: 'c', retryable: false, details: { reason: 'path_taken' } }))).toEqual({ reason: 'path_taken' });
    expect(asConflict(new ApiError(404, { code: 'not_found', message: 'n', retryable: false }))).toBeNull();
    expect(asConflict(new Error('x'))).toBeNull();
  });
});

describe('diff', () => {
  it('a client diff marks added and removed lines; markup stays text', () => {
    const d = diffTexts('current', 'a\nb\n', 'mine', 'a\n<b onclick=x>\n');
    const lines = diffLines(d);
    expect(lines).toContainEqual({ kind: 'del', text: '-b' });
    expect(lines).toContainEqual({ kind: 'add', text: '+<b onclick=x>' });
    expect(lines.some((l) => l.kind === 'hunk')).toBe(true);
    expect(lines.filter((l) => l.kind === 'meta').map((l) => l.text)).toEqual(['--- current', '+++ mine']);
    expect(hasChanges(d)).toBe(true);
    expect(hasChanges(diffTexts('a', 'same\n', 'b', 'same\n'))).toBe(false);
  });
});

describe('paths', () => {
  it('join, folder and the client-side check (the server has the final word)', () => {
    expect(joinPath('a/b/', '/c.md')).toBe('a/b/c.md');
    expect(joinPath('', 'c.md')).toBe('c.md');
    expect(folderOf('a/b/c.md')).toBe('a/b');
    expect(folderOf('c.md')).toBe('');
    expect(pathProblem('notes/a.md')).toBeNull();
    for (const bad of ['', ' ', '/a.md', 'a/', 'a//b', 'a/../b', './a', 'a\\b']) expect(pathProblem(bad), bad).not.toBeNull();
  });

  it('routes of the new screens encode segments', () => {
    expect(routes.edit('s', 'a b/é.md')).toBe('/s/s/edit/a%20b/%C3%A9.md');
    expect(routes.history('s', 'a/b.md')).toBe('/s/s/history/a/b.md');
    expect(routes.newDoc('s', 'a/b')).toBe('/s/s/new?folder=a%2Fb');
    expect(routes.newDoc('s')).toBe('/s/s/new');
    expect(routes.trash('s')).toBe('/s/s/trash');
  });
});

describe('upload', () => {
  it('PUTs the bytes as octet-stream with X-Brain-Client, query from expected_rev, message, request_id', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { status: 'committed' } })));
    setFetch(f as unknown as typeof fetch);
    const file = new Blob([new Uint8Array([1, 2, 3])]);
    await api.upload({ space: 'handoff', path: 'files/scán 1.pdf', file, expected_rev: 0, message: 'Übertragung', request_id: 'ui-1234567890' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/v1/files/handoff/files/sc%C3%A1n%201.pdf?expected_rev=0&message=%C3%9Cbertragung&request_id=ui-1234567890');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(file);
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    expect((init?.headers as Record<string, string>)['X-Brain-Client']).toBe('brain-web');
    expect(init?.credentials).toBe('same-origin');
  });
});

describe('trash', () => {
  it('collects deleted documents only, follows cursors and folders deeper than depth 5', async () => {
    const d = (path: string, deleted: boolean, updated_at = '2026-11-14T00:00:00.000Z') => ({ type: 'doc', id: path, path, deleted, updated_at, title: path });
    const calls: Record<string, unknown>[] = [];
    setFetch((async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(input);
      let result;
      if (input.path === 'a/b/c/d/e') result = { entries: [d('a/b/c/d/e/deep.md', true, '2026-11-13T00:00:00.000Z')] };
      else if (input.cursor === 'p2') result = { entries: [d('z.md', true, '2026-11-15T00:00:00.000Z')] };
      else result = { entries: [{ type: 'folder', path: 'a', children: 1 }, { type: 'folder', path: 'a/b/c/d/e', children: 1 }, d('live.md', false), d('gone.md', true)], next_cursor: 'p2' };
      return new Response(JSON.stringify({ ok: true, result }));
    }) as unknown as typeof fetch);
    const trash = await loadTrash('handoff');
    expect(trash.map((t) => t.path)).toEqual(['z.md', 'gone.md', 'a/b/c/d/e/deep.md']);
    expect(calls.every((c) => c.include_deleted === true && c.depth === 5 && c.space === 'handoff')).toBe(true);
    expect(calls.map((c) => c.path ?? '')).toEqual(['', '', 'a/b/c/d/e']);
  });
});
