// Screens on a stateful fake server: the feed with filters and "needs attention",
// the proposal queue with diff and decision (including a stale one: only on top of the head seen),
// space export, the audit view.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetch } from '../src/api/client';
import type { AuditEntry, ChangeItem, Proposal } from '../src/api/types';
import { App } from '../src/App';

class Fail {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {}
}

const T = '2026-11-14T10:00:00.000Z';
type Session = { name: string; kind: string; trust: string; role: string; admin: boolean };
const ALICE: Session = { name: 'alice', kind: 'human', trust: 'admin', role: 'superadmin', admin: true };
const CAROL: Session = { name: 'carol', kind: 'human', trust: 'trusted', role: 'member', admin: false };

const author = (name: string, trust: 'admin' | 'trusted' | 'limited' = 'trusted') => ({ name, kind: 'agent' as const, trust });

function change(n: number, over: Partial<ChangeItem> = {}): ChangeItem {
  return {
    rev: 1,
    kind: 'update',
    author: author('alice-helper'),
    via: 'mcp',
    message: `edit ${n}`,
    created_at: T,
    size: 10,
    content_hash: 'h',
    purged: false,
    attention: false,
    doc: { id: `D${n}`, space: 'shared', path: `notes/n${n}.md`, title: `Note ${n}` },
    ...over,
  };
}

function proposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    space: 'shared',
    path: 'plan.md',
    doc_id: 'DOCPLAN',
    base_rev: 3,
    content_hash: 'h',
    size: 20,
    message: 'refine the plan',
    author: author('alphabot', 'limited'),
    status: 'open',
    created_at: T,
    human_required: false,
    ...over,
  };
}

const SPACES = [
  { slug: 'shared', name: 'Shared', description: '', role: 'admin', review_mode: 'off', executable: false, protected_paths: [] },
  { slug: 'recipes', name: 'Recipes', description: '', role: 'read', review_mode: 'off', executable: true, protected_paths: [] },
];

function server(opts: { session?: Session; feed?: ChangeItem[]; proposals?: Proposal[]; audit?: AuditEntry[]; head?: number; extra?: Record<string, (i: Record<string, unknown>) => unknown> } = {}) {
  const state = { feed: opts.feed ?? [], proposals: opts.proposals ?? [], audit: opts.audit ?? [], head: opts.head ?? 3 };
  const calls: { op: string; input: Record<string, unknown> }[] = [];
  /** The fake server's cursor is just an index; the real one is opaque. */
  const page = <X,>(xs: X[], cursor: unknown, limit: number) => {
    const at = typeof cursor === 'string' && cursor ? Number(cursor) : 0;
    const items = xs.slice(at, at + limit);
    return { items, next: at + limit < xs.length ? String(at + limit) : undefined };
  };
  const findP = (id: unknown) => {
    const p = state.proposals.find((x) => x.id === id);
    if (!p) throw new Fail(404, 'not_found');
    return p;
  };
  const ops: Record<string, (i: Record<string, unknown>) => unknown> = {
    spaces: () => ({ spaces: SPACES }),
    list: () => ({ entries: [] }),
    admin_principal_list: () => ({ principals: [] }),
    activity: (i) => {
      let xs = state.feed;
      if (i.space) xs = xs.filter((x) => x.doc.space === i.space);
      if (i.author) xs = xs.filter((x) => x.author.name === i.author);
      const r = page(xs, i.before, Number(i.limit ?? 50));
      return { items: r.items, ...(r.next ? { next_cursor: r.next } : {}) };
    },
    proposal_list: (i) => {
      let xs = state.proposals;
      if (i.status) xs = xs.filter((x) => x.status === i.status);
      if (i.space) xs = xs.filter((x) => x.space === i.space);
      if (i.mine) xs = xs.filter((x) => x.author.name === (opts.session ?? ALICE).name);
      const r = page(xs, i.cursor, Number(i.limit ?? 50));
      return { proposals: r.items, ...(r.next ? { next_cursor: r.next } : {}) };
    },
    proposal_get: (i) => {
      const p = findP(i.id);
      return { proposal: p, content: 'new text\n', diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old text\n+new text\n', stale: p.base_rev !== state.head && p.doc_id !== undefined };
    },
    proposal_decide: (i) => {
      const p = findP(i.id);
      if (i.decision === 'reject') {
        Object.assign(p, { status: 'rejected', decided_by: { name: 'alice', kind: 'human', trust: 'admin' }, decided_at: T, ...(i.note ? { decision_note: i.note } : {}) });
        return { proposal: p };
      }
      const expected = i.expected_rev ?? p.base_rev;
      if (expected !== state.head) {
        throw new Fail(409, 'conflict', { reason: 'stale_proposal', current: { rev: state.head, content_hash: 'x', author: author('alice-helper'), updated_at: T, content: 'their edit\n' } });
      }
      state.head += 1;
      Object.assign(p, { status: 'accepted', decided_by: { name: 'alice', kind: 'human', trust: 'admin' }, decided_at: T, result_rev: state.head });
      return { proposal: p, doc: { id: p.doc_id, space: p.space, path: p.path, rev: state.head } };
    },
    proposal_withdraw: (i) => {
      const p = findP(i.id);
      p.status = 'withdrawn';
      return { proposal: p };
    },
    read: (i) => ({ doc: { id: i.id, space: 'shared', path: 'plan.md', rev: state.head, kind: 'text' }, revision: {}, encoding: 'utf8', truncated: false }),
    export: (i) => {
      if (i.mode === 'full' && i.space !== 'shared') throw new Fail(403, 'forbidden', { required_role: 'admin' });
      return { export_id: 'EXP1', download_path: '/api/v1/exports/EXP1', size: 2048, sha256: 'ab'.repeat(32), expires_at: '2026-11-14T11:00:00.000Z' };
    },
    admin_audit_query: (i) => {
      let xs = state.audit;
      if (i.principal) xs = xs.filter((x) => x.principal === i.principal);
      if (i.op) xs = xs.filter((x) => x.op === i.op);
      const r = page(xs, i.cursor, Number(i.limit ?? 100));
      return { entries: r.items, ...(r.next ? { next_cursor: r.next } : {}) };
    },
    ...opts.extra,
  };
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const fail = (f: Fail) => new Response(JSON.stringify({ ok: false, error: { code: f.code, message: f.code, retryable: false, details: f.details } }), { status: f.status });
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/auth/session') return ok({ principal: opts.session ?? ALICE });
    const input = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const op = url.replace('/api/v1/ops/', '');
    calls.push({ op, input });
    const h = ops[op];
    if (!h) return fail(new Fail(404, 'not_found'));
    try {
      return ok(h(input));
    } catch (e) {
      if (e instanceof Fail) return fail(e);
      throw e;
    }
  });
  setFetch(f as unknown as typeof fetch);
  return { state, calls, of: (op: string) => calls.filter((c) => c.op === op).map((c) => c.input) };
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

const feedList = () => screen.findByRole('region', { name: 'Changes' });

describe('change feed', () => {
  it('shows who, what, where with links; sidebar links to the feed', async () => {
    server({ feed: [change(1, { attention: true, doc: { id: 'D1', space: 'recipes', path: 'r/soup.md', title: 'Soup' } }), change(2, { kind: 'delete' })] });
    renderAt('/feed');
    const list = await feedList();
    const items = await within(list).findAllByTestId('feed-item');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('alice-helper')).toBeTruthy();
    expect(within(items[0]!).getByText('needs attention')).toBeTruthy();
    expect(within(items[0]!).getByRole('link', { name: 'Soup' }).getAttribute('href')).toBe('/s/recipes/d/r/soup.md');
    expect(within(items[0]!).getByRole('link', { name: 'history' }).getAttribute('href')).toBe('/s/recipes/history/r/soup.md');
    // A deleted document links to the trash, not to a page that doesn't exist.
    expect(within(items[1]!).getByRole('link', { name: 'notes/n2.md' }).getAttribute('href')).toBe('/s/shared/trash');
    const nav = screen.getByRole('complementary', { name: 'Navigation' });
    expect(within(nav).getByRole('link', { name: 'Activity feed' }).getAttribute('href')).toBe('/feed');
  });

  it('space and author filters go to the server and into the address', async () => {
    const s = server({ feed: [change(1), change(2, { author: author('alphabot', 'limited'), doc: { id: 'D2', space: 'recipes', path: 'x.md', title: 'X' } })] });
    renderAt('/feed');
    await feedList();
    fireEvent.change(screen.getByLabelText('Space'), { target: { value: 'recipes' } });
    await waitFor(() => expect(s.of('activity').at(-1)).toMatchObject({ space: 'recipes' }));
    fireEvent.change(screen.getByLabelText('Person or agent'), { target: { value: ' alphabot ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(s.of('activity').at(-1)).toEqual({ space: 'recipes', author: 'alphabot', limit: 50 }));
    expect(await within(await feedList()).findAllByTestId('feed-item')).toHaveLength(1);
  });

  it('opens with filters from the address; “Reset” clears them', async () => {
    const s = server({ feed: [change(1)] });
    renderAt('/feed?space=shared&author=alice-helper');
    await waitFor(() => expect(s.of('activity')[0]).toEqual({ space: 'shared', author: 'alice-helper', limit: 50 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(s.of('activity').at(-1)).toEqual({ limit: 50 }));
  });

  it('“needs attention” keeps reading pages until it finds attention items; pagination by before', async () => {
    // 120 ordinary edits, then 2 "needs attention": the first two pages (50 each) have none.
    const feed = [...Array.from({ length: 120 }, (_, n) => change(n)), change(500, { attention: true }), change(501, { attention: true })];
    const s = server({ feed });
    renderAt('/feed?attention=1');
    const list = await feedList();
    await waitFor(() => expect(within(list).getAllByTestId('feed-item')).toHaveLength(2));
    expect(within(list).getByText('Changes reviewed: 122.', { exact: false })).toBeTruthy();
    const befores = s.of('activity').map((i) => i.before);
    expect(befores).toEqual([undefined, '50', '100']);
    // End of the feed: no "more" button.
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('without attention: “Show more” loads the next page', async () => {
    const s = server({ feed: Array.from({ length: 60 }, (_, n) => change(n)) });
    renderAt('/feed');
    const list = await feedList();
    expect(await within(list).findAllByTestId('feed-item')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list).getAllByTestId('feed-item')).toHaveLength(60));
    expect(s.of('activity').at(-1)).toMatchObject({ before: '50' });
  });
});

describe('proposal queue', () => {
  it('lists open proposals by default with a count in the sidebar; status tabs filter', async () => {
    const s = server({ proposals: [proposal('P1'), proposal('P2', { status: 'accepted', path: 'done.md' }), proposal('P3', { human_required: true, space: 'recipes', path: 'r.md' })] });
    renderAt('/proposals');
    expect(await screen.findByText('plan.md')).toBeTruthy();
    expect(screen.getByText('r.md')).toBeTruthy();
    expect(screen.getByText('human only')).toBeTruthy();
    expect(screen.queryByText('done.md')).toBeNull();
    expect(s.of('proposal_list')).toContainEqual({ status: 'open', limit: 50 });
    const nav = screen.getByRole('complementary', { name: 'Navigation' });
    expect(await within(nav).findByLabelText('open: 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accepted' }));
    expect(await screen.findByText('done.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(s.of('proposal_list').at(-1)).toEqual({ limit: 50 }));
  });

  it('a fresh proposal: diff, accept with a note → accepted, revision shown, request_id sent', async () => {
    const s = server({ proposals: [proposal('P1')] });
    renderAt('/proposals/P1');
    const diff = await screen.findByLabelText('Difference between the current and the proposed version');
    expect(within(diff).getByText('+new text')).toBeTruthy();
    expect(within(diff).getByText('-old text')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Comment to the author'), { target: { value: 'thanks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Accepted: revision 4.')).toBeTruthy();
    const [input] = s.of('proposal_decide');
    expect(input).toMatchObject({ id: 'P1', decision: 'accept', note: 'thanks' });
    expect(input).not.toHaveProperty('expected_rev');
    expect(String(input!.request_id)).toMatch(/^ui-/);
    expect(await screen.findByText('accepted')).toBeTruthy();
  });

  it('a proposal over 1000 differing lines: no diff, a note instead (diff_truncated)', async () => {
    server({
      proposals: [proposal('P1')],
      extra: { proposal_get: () => ({ proposal: proposal('P1'), content: 'new text\n', diff: '', diff_truncated: true, stale: false }) },
    });
    renderAt('/proposals/P1');
    expect(await screen.findByText(/More than 1000 lines differ/)).toBeTruthy();
    expect(screen.queryByLabelText('Difference between the current and the proposed version')).toBeNull();
    expect(screen.getByLabelText('Proposed text').textContent).toBe('new text\n');
  });

  it('reject → rejected', async () => {
    const s = server({ proposals: [proposal('P1')] });
    renderAt('/proposals/P1');
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected.')).toBeTruthy();
    expect(s.of('proposal_decide')[0]).toMatchObject({ id: 'P1', decision: 'reject' });
  });

  it('stale: warns, shows the current head and accepts only over it (expected_rev)', async () => {
    const s = server({ proposals: [proposal('P1', { base_rev: 2 })], head: 5 });
    renderAt('/proposals/P1');
    expect(await screen.findByText(/The document changed after the proposal \(now at revision 5\)/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept on top of rev 5' }));
    expect(await screen.findByText('Accepted: revision 6.')).toBeTruthy();
    expect(s.of('proposal_decide')[0]).toMatchObject({ decision: 'accept', expected_rev: 5 });
  });

  it('the head moves while deciding: conflict → refreshed, then accept over the new head', async () => {
    const s = server({ proposals: [proposal('P1')], head: 3 });
    renderAt('/proposals/P1');
    await screen.findByRole('button', { name: 'Accept' });
    s.state.head = 4; // someone wrote while the human was reading the diff
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    const over = await screen.findByRole('button', { name: 'Accept on top of rev 4' });
    expect(s.state.proposals[0]!.status).toBe('open');
    fireEvent.click(over);
    expect(await screen.findByText('Accepted: revision 5.')).toBeTruthy();
    expect(s.of('proposal_decide').map((i) => i.expected_rev)).toEqual([undefined, 4]);
    // proposal_get is reread after the conflict: the diff is shown against the new head.
    expect(s.of('proposal_get').length).toBeGreaterThanOrEqual(2);
  });

  it('own proposal: no accept, only withdraw', async () => {
    const s = server({ session: CAROL, proposals: [proposal('P1', { author: { name: 'carol', kind: 'human', trust: 'trusted' } })] });
    renderAt('/proposals/P1');
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(s.of('proposal_withdraw')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(await screen.findByText('withdrawn')).toBeTruthy();
  });

  it('a decided proposal has no decision bar; server errors are shown', async () => {
    server({ proposals: [proposal('P1', { status: 'rejected', decided_by: { name: 'alice', kind: 'human', trust: 'admin' }, decision_note: 'not quite' })] });
    renderAt('/proposals/P1');
    expect(await screen.findByText(/Comment: not quite/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Decision' })).toBeNull();
    cleanup();
    server({ proposals: [proposal('P2')], extra: { proposal_decide: () => { throw new Fail(403, 'forbidden'); } } });
    renderAt('/proposals/P2');
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Not enough permissions.')).toBeTruthy();
  });

  it('unknown proposal → “Not found.”', async () => {
    server();
    renderAt('/proposals/NOPE');
    expect(await screen.findByText('Not found.')).toBeTruthy();
  });
});

describe('export', () => {
  it('builds a head archive and offers the download link; full needs the admin role', async () => {
    const s = server();
    renderAt('/export?space=recipes');
    const full = await screen.findByRole('radio', { name: /Full, with history/ });
    expect((full as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Build archive' }));
    const ready = await screen.findByRole('region', { name: 'Archive ready' });
    expect(within(ready).getByRole('link', { name: 'Download archive' }).getAttribute('href')).toBe('/api/v1/exports/EXP1');
    expect(within(ready).getByText('ab'.repeat(32))).toBeTruthy();
    expect(s.of('export')[0]).toEqual({ space: 'recipes', mode: 'head' });
  });

  it('full mode for an admin space; space chosen from the list', async () => {
    const s = server();
    renderAt('/export');
    fireEvent.change(await screen.findByLabelText('Space'), { target: { value: 'shared' } });
    fireEvent.click(await screen.findByRole('radio', { name: /Full, with history/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Build archive' }));
    await screen.findByRole('region', { name: 'Archive ready' });
    expect(s.of('export')[0]).toEqual({ space: 'shared', mode: 'full' });
  });

  it('the space ⋯ menu links to its export and activity (Export left the main navigation)', async () => {
    server();
    renderAt('/s/shared');
    const main = await screen.findByRole('main');
    fireEvent.click(await within(main).findByRole('button', { name: 'More actions' }));
    const menu = within(within(main).getByRole('menu'));
    expect(menu.getByRole('menuitem', { name: 'Export' }).getAttribute('href')).toBe('/export?space=shared');
    expect(menu.getByRole('menuitem', { name: 'Activity' }).getAttribute('href')).toBe('/feed?space=shared');
    expect(within(screen.getByRole('complementary', { name: 'Navigation' })).queryByRole('link', { name: 'Export' })).toBeNull();
  });
});

const entry = (id: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  ts: T,
  principal: 'alphabot',
  token_id: 'TOK1',
  via: 'mcp',
  op: 'read',
  outcome: 'ok',
  space: 'shared',
  doc_id: 'DOC1',
  rev: 2,
  request_id: null,
  ip: '10.0.0.5',
  detail: null,
  ...over,
});

describe('audit (Advanced)', () => {
  it('without the admin capability there is no audit screen and no admin call', async () => {
    const s = server({ session: CAROL });
    renderAt('/admin/audit');
    expect(await screen.findByText('Not found.')).toBeTruthy();
    expect(s.calls.some((c) => c.op.startsWith('admin_'))).toBe(false);
  });

  it('lists entries, filters by form and by clicking a value, pages by cursor', async () => {
    const audit = [
      entry(1, { op: 'search', detail: { query: 'plan', results: 3 } }),
      entry(2, { principal: null, op: 'auth', outcome: 'unauthenticated', space: null, doc_id: null, token_id: null }),
      ...Array.from({ length: 110 }, (_, n) => entry(10 + n, { principal: 'alice-helper', op: 'write' })),
    ];
    const s = server({ audit });
    renderAt('/admin/audit');
    const list = await screen.findByRole('region', { name: 'Audit entries' });
    expect(await within(list).findAllByTestId('audit-entry')).toHaveLength(100);
    expect(within(list).getByText('query: plan · results: 3')).toBeTruthy();
    expect(within(list).getByText('not signed in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list).getAllByTestId('audit-entry')).toHaveLength(112));
    expect(s.of('admin_audit_query').at(-1)).toMatchObject({ cursor: '100' });

    fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'alphabot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(s.of('admin_audit_query').at(-1)).toEqual({ principal: 'alphabot', limit: 100 }));
    const l2 = await screen.findByRole('region', { name: 'Audit entries' });
    await waitFor(() => expect(within(l2).getAllByTestId('audit-entry')).toHaveLength(1));
    fireEvent.click(within(l2).getByRole('button', { name: 'search' }));
    await waitFor(() => expect(s.of('admin_audit_query').at(-1)).toEqual({ principal: 'alphabot', op: 'search', limit: 100 }));
  });

  it('time range goes to the server as ISO; Audit is in the sidebar (no admin tab bar)', async () => {
    const s = server();
    renderAt('/admin/audit');
    const nav = await screen.findByRole('complementary', { name: 'Navigation' });
    expect(within(nav).getByRole('link', { name: 'Audit' }).getAttribute('href')).toBe('/admin/audit');
    expect(screen.queryByRole('navigation', { name: 'Administration' })).toBeNull();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(s.of('admin_audit_query').at(-1)).toEqual({ since: new Date('2026-11-01T00:00').toISOString(), limit: 100 }));
  });
});
