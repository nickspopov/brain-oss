// Screens on a fake server: login, spaces, tree, document, search, download.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetch } from '../src/api/client';
import { App } from '../src/App';

const AUTHOR = { name: 'alice-helper', kind: 'agent', trust: 'trusted' } as const;
const doc = (over: Record<string, unknown> = {}) => ({
  id: '01DOC',
  space: 'handoff',
  path: 'notes/ready.md',
  kind: 'text',
  mime: 'text/markdown',
  title: 'Ready for handover',
  rev: 2,
  content_hash: 'h',
  size: 120,
  updated_at: '2026-11-14T00:00:00.000Z',
  author: AUTHOR,
  trust_floor: 'limited',
  deleted: false,
  expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  tags: ['handoff'],
  ...over,
});
const revision = { rev: 2, kind: 'update', author: AUTHOR, via: 'mcp', message: 'ready', created_at: '2026-11-14T00:00:00.000Z', size: 120, content_hash: 'h', purged: false, attention: false };
const SPACES = [
  { slug: 'handoff', name: 'Handoff', description: 'Task handover', role: 'write', review_mode: 'off', executable: false, ttl_days: 14, protected_paths: [] },
  { slug: 'recipes', name: 'Recipes', description: '', role: 'read', review_mode: 'all', executable: true, protected_paths: ['bin/'] },
];

type Handler = (input: Record<string, unknown>) => unknown;

function fakeServer(opts: { loggedIn: boolean; ops?: Record<string, Handler> }) {
  let loggedIn = opts.loggedIn;
  const calls: { op: string; input: Record<string, unknown> }[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const fail = (status: number, code: string) => new Response(JSON.stringify({ ok: false, error: { code, message: code, retryable: false } }), { status });
  const ops: Record<string, Handler> = {
    spaces: () => ({ spaces: SPACES }),
    list: (i) =>
      i.path === 'notes'
        ? { entries: [{ type: 'doc', ...doc() }] }
        : { entries: [{ type: 'folder', path: 'notes', children: 1 }, { type: 'doc', ...doc({ id: '01F', path: 'scan.pdf', kind: 'file', mime: 'application/pdf', title: 'scan.pdf' }) }] },
    ...opts.ops,
  };
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const input = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url === '/api/v1/auth/session') return loggedIn ? ok({ principal: { name: 'alice', kind: 'human', trust: 'admin', role: 'superadmin', admin: true } }) : fail(401, 'unauthenticated');
    if (url === '/api/v1/auth/login') {
      if (input.password !== 'pw') return fail(401, 'unauthenticated');
      loggedIn = true;
      return ok({ principal: { name: 'alice', kind: 'human', trust: 'admin', role: 'superadmin', admin: true } });
    }
    if (url === '/api/v1/auth/password') {
      calls.push({ op: 'auth/password', input });
      if (input.current_password !== 'pw') {
        return new Response(
          JSON.stringify({ ok: false, error: { code: 'invalid_input', message: 'x', retryable: false, details: { issues: [{ path: 'current_password', message: 'x' }] } } }),
          { status: 400 },
        );
      }
      return ok({ changed: true, revoked_sessions: 2 });
    }
    if (url === '/api/v1/auth/logout') {
      loggedIn = false;
      return ok({ logged_out: true });
    }
    const op = url.replace('/api/v1/ops/', '');
    calls.push({ op, input });
    if (!loggedIn) return fail(401, 'unauthenticated');
    const h = ops[op];
    if (!h) return fail(404, 'not_found');
    try {
      return ok(h(input));
    } catch (e) {
      return fail(404, (e as Error).message);
    }
  });
  setFetch(f as unknown as typeof fetch);
  return { calls };
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

describe('login', () => {
  it('unauthenticated → login form; wrong password → message; right → back to the requested page', async () => {
    fakeServer({ loggedIn: false });
    renderAt('/s/handoff');
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Wrong name or password.');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Handoff' })).toBeTruthy();
  });

  it('logout returns to the login form', async () => {
    fakeServer({ loggedIn: true });
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: /^Account menu/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
  });

  it('header is logo · search · avatar menu (name, Account, Theme, Log out); no role badge', async () => {
    fakeServer({ loggedIn: true });
    renderAt('/');
    const header = within((await screen.findAllByRole('banner'))[0]!);
    expect(header.queryByText(/role/)).toBeNull();
    expect(header.queryByRole('button', { name: /Theme/ })).toBeNull();
    fireEvent.click(header.getByRole('button', { name: /^Account menu/ }));
    const menu = within(screen.getByRole('menu', { name: 'Account menu' }));
    expect(menu.getByText('alice')).toBeTruthy();
    expect(menu.getByRole('menuitem', { name: 'Account' }).getAttribute('href')).toBe('/account');
    const theme = menu.getByRole('menuitem', { name: 'Theme: system' });
    fireEvent.click(theme);
    expect(menu.getByRole('menuitem', { name: 'Theme: light' })).toBeTruthy();
    expect(menu.getByRole('menuitem', { name: 'Log out' })).toBeTruthy();
  });
});

describe('account', () => {
  it('header → Account shows the principal and changes the password with clear messages', async () => {
    const { calls } = fakeServer({ loggedIn: true });
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: /^Account menu/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Account' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeTruthy();
    // One administrator line, no Kind/Role rows.
    expect(screen.getByText('Superadmin: full access to everything in this Brain.')).toBeTruthy();
    expect(screen.queryByText('Kind')).toBeNull();
    const fill = (cur: string, next: string, rep: string) => {
      fireEvent.change(screen.getByLabelText('Current password'), { target: { value: cur } });
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
      fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: rep } });
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    };
    fill('pw', 'short', 'short');
    expect((await screen.findByRole('alert')).textContent).toBe('The new password must be at least 12 characters.');
    fill('pw', 'long-enough-password', 'long-enough-passwordX');
    expect((await screen.findByRole('alert')).textContent).toBe('The new passwords do not match.');
    expect(calls.some((c) => c.op === 'auth/password')).toBe(false);
    fill('bad', 'long-enough-password', 'long-enough-password');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The current password is incorrect.'));
    fill('pw', 'long-enough-password', 'long-enough-password');
    expect((await screen.findByRole('status')).textContent).toBe('Password changed. 2 other sessions were signed out.');
    expect(calls.at(-1)?.input).toEqual({ current_password: 'pw', new_password: 'long-enough-password' });
  });
});

describe('spaces and tree', () => {
  it('spaces show only exceptional rules, never defaults or the viewer’s role', async () => {
    fakeServer({ loggedIn: true });
    renderAt('/');
    const main = within(await screen.findByRole('main'));
    await main.findByText('Task handover');
    for (const dflt of [/review: off/i, 'protected paths: none', 'TTL: none', /executable/, /^role:/]) expect(main.queryByText(dflt)).toBeNull();
    expect(main.getByText('TTL: 14 days')).toBeTruthy();
    // Approval for everyone together with flagged edits is no preset: "Review: custom".
    expect(main.getByText('Review: custom')).toBeTruthy();
    expect(main.getByText('protected paths: bin/')).toBeTruthy();
  });

  it('archived spaces (seen by a superadmin) are hidden on home and in the sidebar behind “Show archived”', async () => {
    fakeServer({ loggedIn: true, ops: { spaces: () => ({ spaces: [...SPACES, { ...SPACES[1], slug: 'old-wiki', name: 'Old wiki', archived: true }] }) } });
    renderAt('/');
    const main = within(await screen.findByRole('main'));
    await main.findByText('Task handover');
    const nav = within(screen.getByRole('complementary', { name: 'Navigation' }));
    expect(nav.getByRole('link', { name: 'Recipes' })).toBeTruthy();
    expect(nav.queryByRole('link', { name: 'Old wiki' })).toBeNull();
    expect(main.queryByText('Old wiki')).toBeNull();
    fireEvent.click(main.getByRole('checkbox', { name: 'Show archived (1)' }));
    expect(await main.findByText('Old wiki')).toBeTruthy();
    expect(main.getByText('archived')).toBeTruthy();
  });

  it('the tree loads a folder on demand and links documents', async () => {
    const { calls } = fakeServer({ loggedIn: true });
    renderAt('/s/handoff');
    const content = within(await screen.findByRole('region', { name: 'Contents' }));
    const folder = await content.findByRole('button', { name: /notes/ });
    expect(content.getByRole('treeitem', { name: /notes/ }).getAttribute('aria-expanded')).toBe('false');
    expect(calls.some((c) => c.op === 'list' && c.input.path === 'notes')).toBe(false);
    fireEvent.click(folder);
    const link = await content.findByRole('link', { name: 'ready.md' });
    expect(link.getAttribute('href')).toBe('/s/handoff/d/notes/ready.md');
    expect(calls.some((c) => c.op === 'list' && c.input.path === 'notes')).toBe(true);
  });

  it('the menu button opens the drawer on a phone', async () => {
    fakeServer({ loggedIn: true });
    renderAt('/');
    const menu = await screen.findByRole('button', { name: 'Menu' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('sidebar')?.className).toContain('translate-x-0');
  });
});

describe('document view', () => {
  it('shows markdown, author with trust, trust_floor, TTL, tags, message and a download link', async () => {
    const content = '---\ntags: [handoff]\n---\n# Ready for handover\n\nText <script>window.__x=1</script> and [neighbour](other.md).\n';
    const { calls } = fakeServer({
      loggedIn: true,
      ops: {
        read: (i) => {
          expect(i).toMatchObject({ space: 'handoff', path: 'notes/ready.md' });
          return { doc: doc(), revision, encoding: 'utf8', truncated: false, ...(i.format === 'full' ? { content } : {}) };
        },
      },
    });
    renderAt('/s/handoff/d/notes/ready.md');
    const article = within(await screen.findByRole('article'));
    await article.findByRole('heading', { level: 1, name: 'Ready for handover' });
    await waitFor(() => expect(article.getAllByRole('heading', { name: 'Ready for handover' })).toHaveLength(2));
    expect(article.getByText('alice-helper')).toBeTruthy();
    // Trust is hidden in the header; the trust floor is under Details.
    expect(article.queryByTitle('trust level: trusted')).toBeNull();
    expect(article.getByText('Details')).toBeTruthy();
    expect(article.getByTitle('trust level: limited').textContent).toBe('limited');
    expect(article.getByText(/expires: in 3 days/)).toBeTruthy();
    expect(article.getByText('#handoff')).toBeTruthy();
    expect(article.getByText('ready')).toBeTruthy();
    expect(article.getByText('Frontmatter')).toBeTruthy();
    expect(article.getByText(/<script>window.__x=1<\/script>/)).toBeTruthy();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
    expect(article.getByRole('link', { name: 'neighbour' }).getAttribute('href')).toBe('/s/handoff/d/notes/other.md');
    expect(article.getByRole('link', { name: /Download/ }).getAttribute('href')).toBe('/api/v1/docs/01DOC/raw');
    expect(calls.filter((c) => c.op === 'read').map((c) => c.input.format)).toEqual(['meta', 'full']);
  });

  it('a file is offered only as a download; its body is not requested', async () => {
    const { calls } = fakeServer({
      loggedIn: true,
      ops: { read: () => ({ doc: doc({ id: '01F', path: 'scan.pdf', kind: 'file', mime: 'application/pdf', title: 'scan.pdf', expires_at: undefined }), revision, encoding: 'base64', truncated: false }) },
    });
    renderAt('/s/handoff/d/scan.pdf');
    const link = await screen.findByRole('link', { name: /Download/ });
    expect(link.getAttribute('href')).toBe('/api/v1/docs/01F/raw');
    expect(screen.getByText(/It can only be downloaded/)).toBeTruthy();
    expect(calls.filter((c) => c.op === 'read').map((c) => c.input.format)).toEqual(['meta']);
  });

  it('an old revision is labelled and links back to the head', async () => {
    fakeServer({ loggedIn: true, ops: { read: (i) => ({ doc: doc({ rev: 5 }), revision: { ...revision, rev: i.rev }, encoding: 'utf8', truncated: false, content: 'old' }) } });
    renderAt('/s/handoff/d/notes/ready.md?rev=2');
    expect(await screen.findByText(/This is revision 2 of 5/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the current one' }).getAttribute('href')).toBe('/s/handoff/d/notes/ready.md');
  });

  it('not found looks the same whether missing or hidden', async () => {
    fakeServer({ loggedIn: true, ops: { read: () => { throw new Error('not_found'); } } });
    renderAt('/s/proj-beta/d/secret.md');
    expect((await screen.findByRole('alert')).textContent).toBe('Not found.');
  });
});

describe('search', () => {
  it('highlights matches from snippet offsets and links to the document', async () => {
    const { calls } = fakeServer({
      loggedIn: true,
      ops: {
        search: () => ({ results: [{ doc: doc(), snippet: { text: 'for <b>handover</b> tasks', highlights: [[7, 15]] }, matched_in: ['body'] }] }),
      },
    });
    renderAt('/search?q=handover&space=handoff');
    const results = within(await screen.findByRole('list', { name: 'Search results' }));
    const mark = results.getByText('handover');
    expect(mark.tagName).toBe('MARK');
    expect(results.getByText('<b>', { exact: false })).toBeTruthy();
    expect(results.getByRole('link', { name: 'Ready for handover' }).getAttribute('href')).toBe('/s/handoff/d/notes/ready.md');
    expect(calls.find((c) => c.op === 'search')?.input).toMatchObject({ query: 'handover', spaces: ['handoff'] });
  });

  it('empty result says so', async () => {
    fakeServer({ loggedIn: true, ops: { search: () => ({ results: [] }) } });
    renderAt('/search?q=nothing');
    expect(await screen.findByText('Nothing found.')).toBeTruthy();
  });
});
