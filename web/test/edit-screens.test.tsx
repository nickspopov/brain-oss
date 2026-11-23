// Screens on a fake server: editing with expected_rev, conflict, proposal, secret,
// new document, history with diff and revert, move, delete, trash, file upload.
// CodeMirror is replaced by a textarea (the real one is tested in codemirror.test.tsx).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetch } from '../src/api/client';
import { App } from '../src/App';

vi.mock('../src/components/CodeEditor', () => ({
  default: ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
    <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const ALICE = { name: 'alice', kind: 'human', trust: 'admin' } as const;
const AGENT = { name: 'alice-helper', kind: 'agent', trust: 'trusted' } as const;
const SPACES = [{ slug: 'handoff', name: 'Handoff', description: '', role: 'write', review_mode: 'off', executable: false, protected_paths: [] }];

const doc = (over: Record<string, unknown> = {}) => ({
  id: '01DOC',
  space: 'handoff',
  path: 'notes/plan.md',
  kind: 'text',
  mime: 'text/markdown',
  title: 'Plan',
  rev: 2,
  content_hash: 'h',
  size: 20,
  updated_at: '2026-11-14T00:00:00.000Z',
  author: AGENT,
  trust_floor: 'trusted',
  deleted: false,
  ...over,
});
const rev = (n: number, over: Record<string, unknown> = {}) => ({
  rev: n,
  kind: n === 1 ? 'create' : 'update',
  author: n === 1 ? ALICE : AGENT,
  via: n === 1 ? 'ui' : 'mcp',
  message: `m${n}`,
  created_at: `2026-11-1${n}T00:00:00.000Z`,
  size: 10,
  content_hash: `h${n}`,
  purged: false,
  attention: false,
  ...over,
});

class Fail {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {}
}

type Handler = (input: Record<string, unknown>) => unknown;
type Call = { op: string; input: Record<string, unknown>; url: string; init?: RequestInit | undefined };

function fakeServer(ops: Record<string, Handler>, opts: { put?: (url: string, body: unknown) => unknown } = {}) {
  const calls: Call[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const fail = (f: Fail) => new Response(JSON.stringify({ ok: false, error: { code: f.code, message: f.code, retryable: false, details: f.details } }), { status: f.status });
  const all: Record<string, Handler> = {
    spaces: () => ({ spaces: SPACES }),
    list: () => ({ entries: [] }),
    read: () => ({ doc: doc(), revision: rev(2), content: '# Plan\n\nline\n', encoding: 'utf8', truncated: false }),
    ...ops,
  };
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/auth/session') return ok({ principal: { name: 'alice', kind: 'human', trust: 'admin', role: 'superadmin', admin: true } });
    const run = (h: () => unknown) => {
      try {
        return ok(h());
      } catch (e) {
        if (e instanceof Fail) return fail(e);
        throw e;
      }
    };
    if (init?.method === 'PUT') {
      calls.push({ op: 'PUT', input: {}, url, init });
      return run(() => opts.put!(url, init.body));
    }
    const input = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const op = url.replace('/api/v1/ops/', '');
    calls.push({ op, input, url, init });
    const h = all[op];
    if (!h) return fail(new Fail(404, 'not_found'));
    return run(() => h(input));
  });
  setFetch(f as unknown as typeof fetch);
  return { calls, of: (op: string) => calls.filter((c) => c.op === op) };
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

async function editorText(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('Document text')) as HTMLTextAreaElement;
}

describe('editor', () => {
  it('opens the head, previews markdown, saves with expected_rev, message and request_id, then shows the document', async () => {
    let saved = false;
    const s = fakeServer({
      read: () =>
        saved
          ? { doc: doc({ rev: 3, author: ALICE }), revision: rev(3, { author: ALICE, via: 'ui' }), content: '# Plan\n\nnew line\n', encoding: 'utf8', truncated: false }
          : { doc: doc(), revision: rev(2), content: '# Plan\n\nline\n', encoding: 'utf8', truncated: false },
      write: () => ((saved = true), { status: 'committed', doc: doc({ rev: 3 }) }),
    });
    renderAt('/s/handoff/edit/notes/plan.md');
    const ta = await editorText();
    expect(ta.value).toBe('# Plan\n\nline\n');
    expect(screen.getByText('· from revision 2')).toBeTruthy();
    fireEvent.change(ta, { target: { value: '# Plan\n\nnew line\n' } });
    expect(screen.getByText('· unsaved')).toBeTruthy();
    // The preview is markdown, with no HTML from the text.
    const preview = within(screen.getByRole('region', { name: 'Preview' }));
    expect(preview.getByRole('heading', { name: 'Plan' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Revision message'), { target: { value: 'refined the plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved: revision 3.')).toBeTruthy();
    const w = s.of('write')[0]!.input;
    expect(w).toMatchObject({ space: 'handoff', path: 'notes/plan.md', content: '# Plan\n\nnew line\n', expected_rev: 2, message: 'refined the plan' });
    expect(String(w.request_id)).toMatch(/^ui-/);
    expect(await screen.findByText('new line')).toBeTruthy();
  });

  it('conflict: shows my version, the current one and the diff; nothing auto-merges; «keep mine» saves over the current rev', async () => {
    const current = { rev: 3, content_hash: 'h3', author: AGENT, updated_at: '2026-11-14T01:00:00.000Z', content: '# Plan\n\nline\ntheirs\n' };
    let attempt = 0;
    const s = fakeServer({
      write: () => {
        attempt++;
        if (attempt === 1) throw new Fail(409, 'conflict', { reason: 'stale', current, diff: '--- a\n+++ b\n@@ -1,3 +1,4 @@\n # Plan\n \n line\n+theirs\n' });
        return { status: 'committed', doc: doc({ rev: 4 }) };
      },
    });
    renderAt('/s/handoff/edit/notes/plan.md');
    fireEvent.change(await editorText(), { target: { value: '# Plan\n\nmine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const box = within(await screen.findByRole('region', { name: 'Conflict: nothing was saved' }));
    expect(box.getByText('The document changed while you were editing it.')).toBeTruthy();
    expect(box.getByLabelText('My version').textContent).toBe('# Plan\n\nmine\n');
    expect(box.getByLabelText('Current version').textContent).toBe(current.content);
    const diff = box.getByLabelText('Difference between the current version and mine');
    expect(within(diff).getByText('+mine')).toBeTruthy();
    expect(within(diff).getByText('-theirs')).toBeTruthy();
    expect(box.getByLabelText('Changes since the edit started')).toBeTruthy();
    // While the conflict is open, saving is not possible.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(box.getByRole('button', { name: 'Keep editing on top of revision 3' }));
    expect((await editorText()).value).toBe('# Plan\n\nmine\n');
    expect(screen.getByText('· from revision 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved: revision 4.');
    const writes = s.of('write').map((c) => c.input);
    expect(writes.map((x) => x.expected_rev)).toEqual([2, 3]);
    expect(writes[0]!.request_id).not.toBe(writes[1]!.request_id);
  });

  it('conflict: «take the current version» replaces the text and the base revision', async () => {
    const current = { rev: 5, content_hash: 'h5', author: AGENT, updated_at: '2026-11-14T01:00:00.000Z', content: 'current\n' };
    fakeServer({
      write: () => {
        throw new Fail(409, 'conflict', { reason: 'stale', current });
      },
    });
    renderAt('/s/handoff/edit/notes/plan.md');
    fireEvent.change(await editorText(), { target: { value: 'my text\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Take the current version' }));
    expect((await editorText()).value).toBe('current\n');
    expect(screen.getByText('· from revision 5')).toBeTruthy();
    expect(screen.queryByText('· unsaved')).toBeNull();
  });

  it('a write that became a proposal says so and leaves the document unchanged', async () => {
    fakeServer({
      write: () => ({
        status: 'proposed',
        proposal: { id: 'P1', space: 'handoff', path: 'notes/plan.md', base_rev: 2, content_hash: 'x', size: 1, message: 'm', author: ALICE, status: 'open', created_at: 't', human_required: false },
      }),
    });
    renderAt('/s/handoff/edit/notes/plan.md');
    fireEvent.change(await editorText(), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByText(/saved as a proposal/)).textContent).toContain('P1');
  });

  it('secret_detected lists findings without the value; the human superadmin may confirm with allow_secret', async () => {
    let n = 0;
    const s = fakeServer({
      write: () => {
        if (n++ === 0) throw new Fail(422, 'secret_detected', { findings: [{ rule: 'aws-access-key', line: 3, column: 1 }] });
        return { status: 'committed', doc: doc({ rev: 3 }) };
      },
    });
    renderAt('/s/handoff/edit/notes/plan.md');
    fireEvent.change(await editorText(), { target: { value: 'AKIA…' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('aws-access-key: line 3, column 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'This is not a secret — save it (superadmin)' }));
    await screen.findByText('Saved: revision 3.');
    expect(s.of('write').map((c) => c.input.allow_secret)).toEqual([undefined, true]);
  });

  it('files and truncated documents are not edited in the browser', async () => {
    fakeServer({ read: () => ({ doc: doc({ kind: 'file', mime: 'application/pdf' }), revision: rev(2), encoding: 'base64', truncated: false }) });
    renderAt('/s/handoff/edit/notes/plan.md');
    expect(await screen.findByText(/This is a file/)).toBeTruthy();
    expect(screen.queryByLabelText('Document text')).toBeNull();
    cleanup();
    fakeServer({ read: () => ({ doc: doc(), revision: rev(2), content: 'beginning', encoding: 'utf8', truncated: true }) });
    renderAt('/s/handoff/edit/notes/plan.md');
    expect(await screen.findByText(/too large to edit in the browser/)).toBeTruthy();
  });

  it('a new document is created with expected_rev 0 at the given path; a taken path is a conflict, not an overwrite', async () => {
    let n = 0;
    const s = fakeServer({
      write: (i) => {
        if (n++ === 0) throw new Fail(409, 'conflict', { reason: 'already_exists', current: { rev: 7, content_hash: 'h', author: AGENT, updated_at: 't', content: 'theirs\n' } });
        return { status: 'committed', doc: doc({ path: String(i.path), rev: 1 }) };
      },
    });
    renderAt('/s/handoff/new?folder=notes');
    const path = (await screen.findByLabelText('Path in space handoff')) as HTMLInputElement;
    expect(path.value).toBe('notes/');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The path must not start or end with “/”.')).toBeTruthy();
    expect(s.of('write')).toHaveLength(0);

    fireEvent.change(path, { target: { value: 'notes/new.md' } });
    fireEvent.change(await editorText(), { target: { value: '# New\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A document already exists at this path.')).toBeTruthy();
    fireEvent.change(path, { target: { value: 'notes/new2.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved: revision 1.');
    expect(s.of('write').map((c) => [c.input.path, c.input.expected_rev, c.input.message])).toEqual([
      ['notes/new.md', 0, 'Create notes/new.md'],
      ['notes/new2.md', 0, 'Create notes/new2.md'],
    ]);
  });
});

describe('history', () => {
  const history = () => ({ revisions: [rev(3, { kind: 'revert', ref_rev: 1 }), rev(2), rev(1)] });

  it('lists revisions, diffs two of them, and reverts with one click (expected_rev = head)', async () => {
    let head = 3;
    const s = fakeServer({
      read: () => ({ doc: doc({ rev: head }), revision: rev(head), encoding: 'utf8', truncated: false }),
      history,
      diff: (i) => ({ from: i.from, to: i.to, diff: `--- a\n+++ b\n@@ -1 +1 @@\n-before ${String(i.from)}\n+after ${String(i.to)}\n`, added: 1, removed: 1, truncated: false }),
      revert: (i) => ((head = 4), { status: 'committed', doc: doc({ rev: 4 }), ref: i }),
    });
    renderAt('/s/handoff/history/notes/plan.md');
    const list = within(await screen.findByRole('list', { name: 'Revisions' }));
    expect(list.getAllByRole('listitem')).toHaveLength(3);
    expect(list.getByText('→ to revision 1')).toBeTruthy();
    expect(list.getByText('revert')).toBeTruthy();
    // By default, the latest edit (2 → 3).
    expect(await screen.findByText('+after 3')).toBeTruthy();
    expect(s.of('diff')[0]!.input).toMatchObject({ space: 'handoff', path: 'notes/plan.md', from: 2, to: 3 });

    fireEvent.change(screen.getByLabelText('Revision A'), { target: { value: '1' } });
    expect(await screen.findByText('-before 1')).toBeTruthy();
    fireEvent.click(list.getAllByRole('button', { name: 'What changed' })[1]!);
    expect(await screen.findByText('+after 2')).toBeTruthy();

    expect(list.queryByRole('button', { name: 'Revert to rev 3' })).toBeNull();
    fireEvent.click(list.getByRole('button', { name: 'Revert to rev 1' }));
    expect(await screen.findByText('Reverted: revision 4.')).toBeTruthy();
    expect(s.of('revert')[0]!.input).toMatchObject({ space: 'handoff', path: 'notes/plan.md', to_rev: 1, expected_rev: 3, message: 'Revert to revision 1' });
  });

  it('over 1000 differing lines the server sends counts only: the history says so', async () => {
    fakeServer({
      read: () => ({ doc: doc({ rev: 3 }), revision: rev(3), encoding: 'utf8', truncated: false }),
      history,
      diff: (i) => ({ from: i.from, to: i.to, added: 4000, removed: 4000, truncated: true }),
    });
    renderAt('/s/handoff/history/notes/plan.md');
    expect(await screen.findByText(/More than 1000 lines differ/)).toBeTruthy();
    expect(screen.queryByText('The difference is too large: showing the beginning.')).toBeNull();
    expect(screen.getByText('+4000')).toBeTruthy();
  });

  it('a stale revert is a conflict message, not a silent overwrite', async () => {
    fakeServer({
      read: () => ({ doc: doc({ rev: 3 }), revision: rev(3), encoding: 'utf8', truncated: false }),
      history,
      diff: () => ({ from: 2, to: 3, diff: '', added: 0, removed: 0, truncated: false }),
      revert: () => {
        throw new Fail(409, 'conflict', { reason: 'stale' });
      },
    });
    renderAt('/s/handoff/history/notes/plan.md');
    fireEvent.click(await screen.findByRole('button', { name: 'Revert to rev 2' }));
    expect(await screen.findByText('The document changed while you were editing it.')).toBeTruthy();
  });

  it('an old revision has a one-click revert on the document page', async () => {
    const s = fakeServer({
      read: (i) => ({ doc: doc({ rev: 3 }), revision: rev(Number(i.rev ?? 3)), content: 'old', encoding: 'utf8', truncated: false }),
      revert: () => ({ status: 'committed', doc: doc({ rev: 4 }) }),
    });
    renderAt('/s/handoff/d/notes/plan.md?rev=1');
    fireEvent.click(await screen.findByRole('button', { name: 'Revert to this revision' }));
    expect(await screen.findByText('Reverted: revision 4.')).toBeTruthy();
    expect(s.of('revert')[0]!.input).toMatchObject({ to_rev: 1, expected_rev: 3 });
    expect(screen.queryByRole('button', { name: 'Revert to this revision' })).toBeNull();
  });
});

describe('document actions', () => {
  it('the head of a text document offers edit, history, move and delete', async () => {
    fakeServer({});
    renderAt('/s/handoff/d/notes/plan.md');
    const bar = within(await screen.findByRole('toolbar', { name: 'Actions' }));
    expect(bar.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe('/s/handoff/edit/notes/plan.md');
    expect(bar.getByRole('link', { name: 'History' }).getAttribute('href')).toBe('/s/handoff/history/notes/plan.md');
  });

  it('move sends to_path with expected_rev and opens the moved document', async () => {
    let moved = false;
    const s = fakeServer({
      read: () => ({ doc: doc(moved ? { path: 'archive/plan.md' } : {}), revision: rev(2), content: 'x', encoding: 'utf8', truncated: false }),
      move: (i) => ((moved = true), { doc: doc({ path: String(i.to_path), rev: 3 }) }),
    });
    renderAt('/s/handoff/d/notes/plan.md');
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }));
    const form = within(screen.getByRole('form', { name: 'Move' }));
    fireEvent.change(form.getByLabelText('New path'), { target: { value: 'archive/plan.md' } });
    fireEvent.click(form.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Moved: notes/plan.md → archive/plan.md.')).toBeTruthy();
    expect(s.of('move')[0]!.input).toMatchObject({ space: 'handoff', path: 'notes/plan.md', to_path: 'archive/plan.md', expected_rev: 2 });
  });

  it('delete asks first, sends expected_rev and returns to the space with a pointer to the trash', async () => {
    const s = fakeServer({ delete: () => ({ doc: doc({ deleted: true, rev: 3 }) }) });
    renderAt('/s/handoff/d/notes/plan.md');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(s.of('delete')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    expect(await screen.findByText('“Plan” is in the trash. You can restore it from the trash.')).toBeTruthy();
    expect(s.of('delete')[0]!.input).toMatchObject({ space: 'handoff', path: 'notes/plan.md', expected_rev: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Trash' }).getAttribute('href')).toBe('/s/handoff/trash');
  });
});

describe('trash', () => {
  it('lists deleted documents and restores; a taken path asks for another one', async () => {
    let n = 0;
    const s = fakeServer({
      list: () => ({ entries: [{ type: 'doc', ...doc({ id: 'D1', path: 'old.md', title: 'Old notes', deleted: true, author: ALICE }) }, { type: 'doc', ...doc({ id: 'L1', path: 'live.md' }) }] }),
      restore: (i) => {
        if (n++ === 0) throw new Fail(409, 'conflict', { reason: 'path_taken' });
        return { doc: doc({ id: 'D1', path: String(i.path), deleted: false }) };
      },
    });
    renderAt('/s/handoff/trash');
    const list = within(await screen.findByRole('list', { name: 'Deleted documents' }));
    expect(list.getAllByRole('listitem')).toHaveLength(1);
    expect(list.getByText('Old notes')).toBeTruthy();
    expect(s.of('list').some((c) => c.input.include_deleted === true && c.input.depth === 5)).toBe(true);

    fireEvent.click(list.getByRole('button', { name: 'Restore' }));
    expect(await list.findByText('This path is taken by another document.')).toBeTruthy();
    fireEvent.change(list.getByLabelText('New path'), { target: { value: 'old-restored.md' } });
    fireEvent.click(list.getByRole('button', { name: 'Restore' }));
    const link = await list.findByRole('link', { name: 'old-restored.md' });
    expect(link.getAttribute('href')).toBe('/s/handoff/d/old-restored.md');
    expect(s.of('restore').map((c) => c.input)).toEqual([
      expect.objectContaining({ id: 'D1' }),
      expect.objectContaining({ id: 'D1', path: 'old-restored.md' }),
    ]);
    expect(s.of('restore')[0]!.input.path).toBeUndefined();
  });

  it('an empty trash says so', async () => {
    fakeServer({});
    renderAt('/s/handoff/trash');
    expect(await screen.findByText('The trash is empty.')).toBeTruthy();
  });
});

describe('upload', () => {
  it('uploads bytes to the chosen path; an existing file is replaced only on request, over its current rev', async () => {
    let n = 0;
    const s = fakeServer(
      {},
      {
        put: (url) => {
          if (n++ === 0) throw new Fail(409, 'conflict', { reason: 'already_exists', current: { rev: 2, content_hash: 'h', author: AGENT, updated_at: 't' } });
          return { status: 'committed', doc: doc({ path: 'scan.pdf', kind: 'file', rev: 3, url }) };
        },
      },
    );
    renderAt('/s/handoff');
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Upload a file' }));
    const form = within(screen.getByRole('form', { name: 'Upload a file' }));
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'scan.pdf', { type: 'application/pdf' });
    fireEvent.change(form.getByLabelText('File'), { target: { files: [file] } });
    expect((form.getByLabelText('File path') as HTMLInputElement).value).toBe('scan.pdf');
    fireEvent.click(form.getByRole('button', { name: 'Upload' }));
    expect(await form.findByText('A document already exists at this path.')).toBeTruthy();
    fireEvent.click(form.getByRole('button', { name: 'Replace: new revision on top of rev 2' }));
    expect(await form.findByText('Uploaded: revision 3.')).toBeTruthy();

    const puts = s.of('PUT');
    expect(puts.map((c) => c.url.split('?')[0])).toEqual(['/api/v1/files/handoff/scan.pdf', '/api/v1/files/handoff/scan.pdf']);
    expect(new URL(puts[0]!.url, 'http://x').searchParams.get('expected_rev')).toBe('0');
    expect(new URL(puts[1]!.url, 'http://x').searchParams.get('expected_rev')).toBe('2');
    expect(puts[0]!.init?.body).toBe(file);
    expect((puts[0]!.init?.headers as Record<string, string>)['X-Brain-Client']).toBe('brain-web');
  });

  it('a file document offers «new version» over its current rev', async () => {
    const s = fakeServer(
      { read: () => ({ doc: doc({ kind: 'file', mime: 'application/pdf', path: 'scan.pdf', rev: 4 }), revision: rev(4), encoding: 'base64', truncated: false }) },
      { put: () => ({ status: 'committed', doc: doc({ path: 'scan.pdf', kind: 'file', rev: 5 }) }) },
    );
    renderAt('/s/handoff/d/scan.pdf');
    const bar = within(await screen.findByRole('toolbar', { name: 'Actions' }));
    expect(bar.queryByRole('link', { name: 'Edit' })).toBeNull();
    fireEvent.click(bar.getByRole('button', { name: 'New version' }));
    const form = within(screen.getByRole('form', { name: 'Upload a new version' }));
    fireEvent.change(form.getByLabelText('File'), { target: { files: [new File(['x'], 'other-name.pdf')] } });
    fireEvent.click(form.getByRole('button', { name: 'Upload a new version' }));
    await waitFor(() => expect(s.of('PUT')).toHaveLength(1));
    const url = new URL(s.of('PUT')[0]!.url, 'http://x');
    expect(url.pathname).toBe('/api/v1/files/handoff/scan.pdf');
    expect(url.searchParams.get('expected_rev')).toBe('4');
  });
});
