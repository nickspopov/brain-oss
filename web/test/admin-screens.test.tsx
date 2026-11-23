// Admin screens on a stateful fake server: New space → Members, the space's Settings tab
// (Review presets, Advanced, Danger zone), notes for agents, archive; People & agents: tabs, the agent
// page (Overview · Access · Connection · Advanced), tokens shown once, revoke, the connect guide, the one
// "Brain administrator" checkbox, External by Manager, legacy cards; groups; old links redirect.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetch } from '../src/api/client';
import type { AdminGrant, AdminGroup, AdminPrincipal, AdminSpace, AdminToken, LegacyCard, Role } from '../src/api/types';
import { App } from '../src/App';

class Fail {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {}
}

const T = '2026-11-14T00:00:00.000Z';
const MB = 1024 * 1024;

const mkSpace = (slug: string, over: Partial<AdminSpace> = {}): AdminSpace => ({
  id: `01S${slug}`,
  slug,
  name: slug,
  description: '',
  review_mode: 'off',
  executable: false,
  inbox: false,
  ttl_days: null,
  trash_retention_days: null,
  quota_bytes: 500 * MB,
  max_doc_bytes: null,
  protected_paths: [],
  bytes_used: 0,
  archived: false,
  archived_at: null,
  created_at: T,
  ...over,
});

const mkPrincipal = (name: string, over: Partial<AdminPrincipal> = {}): AdminPrincipal => ({
  id: `01P${name}`,
  name,
  display_name: name,
  kind: 'agent',
  role: 'member',
  trust: 'trusted',
  admin: false,
  owner: 'alice',
  harness: null,
  disabled: false,
  disabled_at: null,
  created_at: T,
  ...over,
});

type Session = { name: string; kind: string; trust: string; role: string; admin: boolean };
const SUPER: Session = { name: 'alice', kind: 'human', trust: 'admin', role: 'superadmin', admin: true };

/** A fake server with admin-operation state; anything not described is `not_found`. */
function adminServer(opts: { session?: Session; extra?: Record<string, (i: Record<string, unknown>) => unknown> } = {}) {
  const state = {
    spaces: [mkSpace('shared', { name: 'Shared', protected_paths: ['AGENTS.md'] })],
    principals: [mkPrincipal('alice', { kind: 'human', role: 'superadmin', trust: 'admin', owner: null }), mkPrincipal('alice-helper', { harness: 'hermes' })],
    groups: [{ id: '01Gall', name: 'all-agents', description: 'all agents', system: true, members: ['alice-helper'] }] as AdminGroup[],
    grants: [] as AdminGrant[],
    tokens: [] as AdminToken[],
    cards: {} as Record<string, LegacyCard[]>,
    issued: 0,
  };
  const LAD: Record<Role, string> = { none: 'none', guest: 'guest', read: 'viewer', propose: 'proposer', write: 'editor', admin: 'admin' };
  /** Like the server's read model (core/members): the space-level role, overrides, custom access. */
  const accessOf = (p: AdminPrincipal, slug: string) => {
    const personal = state.grants.find((g) => g.space === slug && g.scope === 'space' && g.subject.type === 'principal' && g.subject.name === p.name);
    const groups = state.grants
      .filter((g) => g.space === slug && g.scope === 'space' && g.subject.type === 'group' && state.groups.find((x) => x.name === g.subject.name)?.members.includes(p.name))
      .map((g) => ({ name: g.subject.name, role: g.role }));
    const overrides = state.grants.filter((g) => g.space === slug && g.scope !== 'space' && g.subject.type === 'principal' && g.subject.name === p.name);
    const superadmin = p.role === 'superadmin';
    const engine: Role = superadmin ? 'admin' : (personal?.role ?? groups[0]?.role ?? 'none');
    const custom = !superadmin && overrides.some((g) => g.role !== engine);
    const member = engine !== 'none' || overrides.some((g) => g.role !== 'none');
    return {
      role: LAD[engine],
      engine_role: engine,
      messages_only: engine === 'guest',
      external_as_guest: false,
      superadmin,
      personal: personal?.role ?? null,
      groups,
      overrides,
      custom,
      visible: engine !== 'guest' && member,
      member,
    };
  };
  const calls: { op: string; input: Record<string, unknown> }[] = [];
  const findSpace = (slug: unknown) => {
    const s = state.spaces.find((x) => x.slug === slug);
    if (!s) throw new Fail(404, 'not_found');
    return s;
  };
  const same = (g: AdminGrant, i: Record<string, unknown>) =>
    g.space === i.space &&
    g.scope === i.scope &&
    (g.path_prefix ?? undefined) === i.path_prefix &&
    (g.doc_id ?? undefined) === i.doc_id &&
    JSON.stringify(g.subject) === JSON.stringify(i.subject);
  const ops: Record<string, (i: Record<string, unknown>) => unknown> = {
    spaces: () => ({
      spaces: state.spaces.map((x) => ({ slug: x.slug, name: x.name, description: x.description, role: 'admin', review_mode: x.review_mode, executable: x.executable, inbox: x.inbox, protected_paths: x.protected_paths, ...(x.archived ? { archived: true } : {}) })),
    }),
    admin_space_members: (i) => {
      const sp = findSpace(i.space);
      const members = state.principals
        .filter((p) => p.kind !== 'system')
        .map((p) => ({ p, access: accessOf(p, sp.slug) }))
        .filter((m) => m.access.member)
        .map(({ p, access }) => ({ name: p.name, display_name: p.display_name, kind: p.kind, external: !!p.external, disabled: p.disabled, what_i_do: p.what_i_do ?? null, access }));
      const names = new Set(members.map((m) => m.name));
      const ambientOff = sp.inbox || sp.slug.startsWith('proj-');
      return {
        space: sp,
        members,
        can_see: members.filter((m) => !m.disabled).length,
        candidates: [
          ...state.principals.filter((p) => p.kind !== 'system' && !p.disabled && !names.has(p.name)).map((p) => ({ type: 'principal', name: p.name, display_name: p.display_name, kind: p.kind, external: !!p.external })),
          ...state.groups.filter((g) => !(g.system && ambientOff)).map((g) => ({ type: 'group', name: g.name, display_name: g.name, kind: 'group', external: false })),
        ],
        notify: { people: members.filter((m) => m.kind === 'human' && m.access.engine_role === 'admin').map((m) => m.display_name), webhooks: 0 },
      };
    },
    admin_access_explain: (i) => {
      const p = state.principals.find((x) => x.name === i.principal);
      if (!p) throw new Fail(404, 'not_found');
      return {
        principal: p,
        groups: state.groups.filter((g) => g.members.includes(p.name)).map((g) => g.name),
        spaces: state.spaces
          .filter((sp) => !i.space || sp.slug === i.space)
          .map((sp) => {
            const access = accessOf(p, sp.slug);
            const grants = state.grants.filter((g) => g.space === sp.slug && g.subject.type === 'principal' && g.subject.name === p.name);
            const override = i.path ? grants.find((g) => g.scope === 'path' && String(i.path).startsWith(g.path_prefix ?? '')) : undefined;
            return {
              space: sp.slug,
              archived: sp.archived,
              visible: access.visible,
              role: access.engine_role,
              grants,
              member: access,
              ...(i.path ? { target: { path: i.path, role: override?.role ?? access.engine_role, level: override ? 'path' : 'space', decided_by: override ? [override] : [] } } : {}),
            };
          }),
      };
    },
    admin_profile_get: (i) => {
      const p = state.principals.find((x) => x.name === i.name);
      if (!p) throw new Fail(404, 'not_found');
      return {
        profile: { name: p.name, display_name: p.display_name, kind: p.kind, what_i_do: p.what_i_do ?? null, contact: p.contact ?? null, manager: p.owner, external: !!p.external, active_today: false, harness: p.harness, last_seen: null, updated_at: null, disabled: p.disabled },
        cards: state.cards[p.name] ?? [],
        conflict: new Set((state.cards[p.name] ?? []).map((c) => c.what_i_do)).size > 1,
      };
    },
    list: () => ({ entries: [] }),
    read: () => {
      throw new Fail(404, 'not_found');
    },
    admin_space_list: (i) => ({ spaces: state.spaces.filter((s) => i.include_archived || !s.archived) }),
    admin_space_create: (i) => {
      if (state.spaces.some((s) => s.slug === i.slug)) throw new Fail(409, 'conflict', { reason: 'slug_taken' });
      const { slug, request_id: _r, ...rest } = i;
      const s = mkSpace(String(slug), { ...(rest as Partial<AdminSpace>), name: typeof rest.name === 'string' ? rest.name : String(slug) });
      state.spaces.push(s);
      return { space: s };
    },
    admin_space_update: (i) => {
      const s = findSpace(i.slug);
      const { slug: _s, new_slug, request_id: _r, ...rest } = i;
      Object.assign(s, rest);
      if (typeof new_slug === 'string') s.slug = new_slug;
      return { space: s };
    },
    admin_space_archive: (i) => {
      const s = findSpace(i.slug);
      Object.assign(s, { archived: true, archived_at: T });
      return { space: s };
    },
    admin_space_unarchive: (i) => {
      const s = findSpace(i.slug);
      Object.assign(s, { archived: false, archived_at: null });
      return { space: s };
    },
    admin_principal_list: () => ({ principals: state.principals }),
    // Like the server: the harness is the one recorded for the agent, or generic; the text has no token.
    admin_connect_guide: (i) => {
      const p = state.principals.find((x) => x.name === i.principal);
      if (i.principal !== undefined && !p) throw new Fail(404, 'not_found');
      const harness = (i.harness as string | undefined) ?? (['claude-code', 'connectome', 'hermes', 'letta'].includes(p?.harness ?? '') ? p!.harness : 'generic');
      const mcp = 'http://localhost/mcp/v1';
      return { harness, transport: 'http', mcp_url: mcp, server_url: 'http://localhost', config: '{}', text: `# Connect ${p?.name ?? 'an agent'} to Brain from ${harness}\nMCP endpoint: ${mcp}`, docs: 'docs/connect/README.md' };
    },
    admin_principal_create: (i) => {
      const { request_id: _r, password: _p, ...rest } = i;
      const p = mkPrincipal(String(i.name), { ...(rest as Partial<AdminPrincipal>), display_name: String(i.display_name ?? i.name), harness: (i.harness as string) ?? null, owner: (i.owner as string) ?? null });
      state.principals.push(p);
      return { principal: p };
    },
    admin_principal_update: (i) => {
      const p = state.principals.find((x) => x.name === i.name)!;
      const { name: _n, request_id: _r, password: _p, ...rest } = i;
      Object.assign(p, rest);
      return { principal: p };
    },
    admin_principal_disable: (i) => {
      const p = state.principals.find((x) => x.name === i.name)!;
      Object.assign(p, { disabled: true, disabled_at: T });
      return { principal: p };
    },
    admin_principal_enable: (i) => {
      const p = state.principals.find((x) => x.name === i.name)!;
      Object.assign(p, { disabled: false, disabled_at: null });
      return { principal: p };
    },
    admin_token_list: (i) => ({ tokens: state.tokens.filter((t) => !i.principal || t.principal === i.principal) }),
    admin_token_issue: (i) => {
      state.issued += 1;
      const token = `brn_${String(state.issued).padStart(43, 'k')}`;
      const info: AdminToken = {
        id: `01T${state.issued}`,
        principal: String(i.principal),
        prefix: token.slice(0, 12),
        label: String(i.label ?? ''),
        created_at: T,
        expires_at: i.days === null ? null : '2027-02-12T00:00:00.000Z',
        revoked: false,
        revoked_at: null,
        last_used_at: null,
        last_used_ip: null,
      };
      state.tokens.push(info);
      return { token, info };
    },
    admin_token_revoke: (i) => {
      const t = state.tokens.find((x) => x.id === i.id)!;
      Object.assign(t, { revoked: true, revoked_at: T });
      return { token: t };
    },
    admin_group_list: () => ({ groups: state.groups }),
    admin_group_create: (i) => {
      const g = { id: `01G${String(i.name)}`, name: String(i.name), description: String(i.description ?? ''), system: false, members: [] };
      state.groups.push(g);
      return { group: g };
    },
    admin_group_members_set: (i) => {
      const g = state.groups.find((x) => x.name === i.name)!;
      g.members = i.members as string[];
      return { group: g };
    },
    admin_grant_list: (i) => ({
      grants: state.grants.filter((g) => (!i.space || g.space === i.space) && (!i.subject || JSON.stringify(g.subject) === JSON.stringify(i.subject))),
    }),
    admin_grant_set: (i) => {
      let g = state.grants.find((x) => same(x, i));
      if (g) g.role = i.role as AdminGrant['role'];
      else {
        g = {
          id: `01R${state.grants.length + 1}`,
          space: String(i.space),
          scope: i.scope as AdminGrant['scope'],
          path_prefix: (i.path_prefix as string) ?? null,
          doc_id: (i.doc_id as string) ?? null,
          subject: i.subject as AdminGrant['subject'],
          role: i.role as AdminGrant['role'],
          granted_by: 'alice',
          granted_at: T,
        };
        state.grants.push(g);
      }
      return { grant: g };
    },
    admin_grant_remove: (i) => {
      const before = state.grants.length;
      state.grants = state.grants.filter((g) => !same(g, i));
      if (state.grants.length === before) throw new Fail(404, 'not_found');
      return { removed: true };
    },
    ...opts.extra,
  };
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const fail = (f: Fail) => new Response(JSON.stringify({ ok: false, error: { code: f.code, message: f.code, retryable: false, details: f.details } }), { status: f.status });
  // Like the server: the same request_id gets the stored response without repeating the action.
  const replays = new Map<string, unknown>();
  /** Operations whose next call will be cut off by the network (it never reaches the server). */
  const dropNext = new Set<string>();
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/auth/session') return ok({ principal: opts.session ?? SUPER });
    const input = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const op = url.replace('/api/v1/ops/', '');
    calls.push({ op, input });
    if (dropNext.delete(op)) throw new TypeError('network down');
    const h = ops[op];
    if (!h) return fail(new Fail(404, 'not_found'));
    const rid = typeof input.request_id === 'string' ? `${op}:${input.request_id}` : undefined;
    if (rid !== undefined && replays.has(rid)) return ok(replays.get(rid));
    try {
      const out = h(input);
      if (rid !== undefined) replays.set(rid, out);
      return ok(out);
    } catch (e) {
      if (e instanceof Fail) return fail(e);
      throw e;
    }
  });
  setFetch(f as unknown as typeof fetch);
  return { state, calls, dropNext, of: (op: string) => calls.filter((c) => c.op === op).map((c) => c.input) };
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

const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('access to the admin section', () => {
  it('without the admin capability: “Not found.”, no admin calls, no admin links', async () => {
    const s = adminServer({ session: { name: 'carol', kind: 'human', trust: 'trusted', role: 'member', admin: false } });
    renderAt('/admin/agents');
    expect(await screen.findByText('Not found.')).toBeTruthy();
    expect(screen.queryByText('Administration')).toBeNull();
    expect(s.calls.some((c) => c.op.startsWith('admin_'))).toBe(false);
  });

  it('with it: the sidebar links to the admin section', async () => {
    adminServer();
    renderAt('/');
    const nav = await screen.findByRole('complementary', { name: 'Navigation' });
    expect(within(nav).getByRole('link', { name: 'People & agents' }).getAttribute('href')).toBe('/admin/agents');
    // One navigation: no tab bar duplicating the sidebar.
    expect(screen.queryByRole('navigation', { name: 'Administration' })).toBeNull();
  });
});

describe('spaces: New space → Members → Settings', () => {
  it('New space asks for a name (slug derived, under Advanced), then opens Members; all-agents is not offered for proj-*', async () => {
    const s = adminServer();
    renderAt('/');
    const nav = await screen.findByRole('complementary', { name: 'Navigation' });
    fireEvent.click(await within(nav).findByRole('link', { name: '+ New space' }));
    const form = await screen.findByRole('form', { name: 'New space' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create space' }));
    expect(within(form).getByRole('alert').textContent).toBe('Give the space a name.');
    change(within(form).getByLabelText('Name'), 'Proj X');
    expect((within(form).getByLabelText('Address (slug)') as HTMLInputElement).value).toBe('proj-x');
    change(within(form).getByLabelText('Description'), 'An isolated project');
    fireEvent.click(within(form).getByRole('button', { name: 'Create space' }));
    expect(await screen.findByText(/Space proj-x created/)).toBeTruthy();
    expect(s.of('admin_space_create')[0]).toMatchObject({ slug: 'proj-x', name: 'Proj X', description: 'An isolated project' });
    expect(String(s.of('admin_space_create')[0]!.request_id)).toMatch(/^ui-/);
    // Members tab: only the superadmin so far.
    const tabs = within(await screen.findByRole('navigation', { name: 'Space sections' }));
    expect(tabs.getByRole('link', { name: 'Members' }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByText('Only this one can see this space.')).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: 'Person, agent or group' });
    fireEvent.focus(picker);
    const list = within(await screen.findByRole('listbox', { name: 'Person, agent or group' }));
    expect(list.queryByText('all-agents')).toBeNull();
    fireEvent.click(list.getByText('alice-helper'));
    change(screen.getByLabelText('Role for the new member'), 'editor');
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('alice-helper added.')).toBeTruthy();
    expect(s.of('admin_grant_set')[0]).toMatchObject({ space: 'proj-x', scope: 'space', subject: { type: 'principal', name: 'alice-helper' }, role: 'write' });
    expect(await screen.findByText('Only these 2 can see this space.')).toBeTruthy();
  });

  it('Members: name · People/Agent · role select on the ladder · ⋯ remove; Proposer kept; Custom access opens Advanced', async () => {
    const s = adminServer();
    s.state.principals.push(mkPrincipal('bob', { kind: 'human', owner: null, display_name: 'Bob' }), mkPrincipal('betabot', { what_i_do: 'Beta things.' }));
    s.state.grants.push(
      { id: '01R1', space: 'shared', scope: 'space', path_prefix: null, doc_id: null, subject: { type: 'principal', name: 'alice-helper' }, role: 'read', granted_by: 'alice', granted_at: T },
      { id: '01R2', space: 'shared', scope: 'path', path_prefix: 'private/', doc_id: null, subject: { type: 'principal', name: 'alice-helper' }, role: 'none', granted_by: 'alice', granted_at: T },
      { id: '01R3', space: 'shared', scope: 'space', path_prefix: null, doc_id: null, subject: { type: 'principal', name: 'betabot' }, role: 'propose', granted_by: 'alice', granted_at: T },
      { id: '01R4', space: 'shared', scope: 'space', path_prefix: null, doc_id: null, subject: { type: 'principal', name: 'bob' }, role: 'admin', granted_by: 'alice', granted_at: T },
    );
    renderAt('/s/shared/members');
    const table = within(await screen.findByRole('table', { name: 'Members' }));
    expect(screen.getByText('Only these 4 can see this space.')).toBeTruthy();
    // Viewer with a folder block: Custom access.
    const hermes = table.getByRole('combobox', { name: 'Role of alice-helper' }) as HTMLSelectElement;
    expect(hermes.value).toBe('viewer');
    expect([...hermes.options].map((o) => o.text)).toEqual(['Viewer', 'Editor', 'Admin']);
    // A proposer stays a proposer (the option is kept for it, even with Review off).
    const betabot = table.getByRole('combobox', { name: 'Role of betabot' }) as HTMLSelectElement;
    expect(betabot.value).toBe('proposer');
    expect([...betabot.options].map((o) => o.text)).toContain('Proposer');
    expect(table.getByText('Beta things.')).toBeTruthy();
    expect(table.getByText('Admin everywhere (superadmin)')).toBeTruthy();
    expect(table.getAllByText('Person').length).toBe(2);
    // Changing a role sets the member's own space-level rule, nothing else.
    change(hermes, 'editor');
    await waitFor(() => expect(s.of('admin_grant_set')[0]).toMatchObject({ space: 'shared', scope: 'space', subject: { type: 'principal', name: 'alice-helper' }, role: 'write' }));
    // Custom access → Advanced access opens with the folder rule.
    fireEvent.click(await table.findByText('Custom access'));
    const rules = await screen.findByRole('list', { name: 'Access rules' });
    expect(within(rules).getByText('folder private/')).toBeTruthy();
    expect(within(rules).getByText('no access (blocked)')).toBeTruthy();
    // ⋯ → Remove from space → confirm.
    fireEvent.click(table.getByRole('button', { name: 'More for bob' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from space…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Bob' }));
    await waitFor(() => expect(s.of('admin_grant_remove')[0]).toMatchObject({ space: 'shared', scope: 'space', subject: { type: 'principal', name: 'bob' } }));
  });

  it('Advanced access: a folder rule needs a folder; it is sent as a normalized prefix', async () => {
    const s = adminServer();
    renderAt('/s/shared/members');
    fireEvent.click(await screen.findByText('Advanced access'));
    const grantForm = await screen.findByRole('form', { name: 'Add access' });
    await waitFor(() => expect(within(grantForm).getByRole('option', { name: 'alice-helper' })).toBeTruthy());
    change(within(grantForm).getByLabelText('Who'), 'principal:alice-helper');
    change(within(grantForm).getByLabelText('Level'), 'path');
    change(within(grantForm).getByLabelText('Role'), 'none');
    fireEvent.click(within(grantForm).getByRole('button', { name: 'Add' }));
    expect(within(grantForm).getByRole('alert').textContent).toMatch(/Enter a folder/);
    change(within(grantForm).getByLabelText('Folder'), '/private/');
    fireEvent.click(within(grantForm).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(s.of('admin_grant_set')).toHaveLength(1));
    expect(s.of('admin_grant_set')[0]).toMatchObject({ scope: 'path', path_prefix: 'private/', role: 'none', subject: { type: 'principal', name: 'alice-helper' } });
    expect(await screen.findByText('no access (blocked)')).toBeTruthy();
  });

  it('Settings: Review presets set only review_mode/executable; Notify me names who is notified; Custom opens Advanced; protected paths explained', async () => {
    const s = adminServer();
    renderAt('/s/shared/settings');
    const settings = await screen.findByRole('form', { name: 'Settings' });
    expect((within(settings).getByRole('radio', { name: /^Off/ }) as HTMLInputElement).checked).toBe(true);
    // Protected paths keep working with Off: said so.
    expect(within(settings).getByText(/Protected paths still need approval.*AGENTS\.md/)).toBeTruthy();
    fireEvent.click(within(settings).getByRole('radio', { name: /^Notify me/ }));
    expect(within(settings).getByText('Flagged edits are shown under Needs attention to the space’s Admins: alice.')).toBeTruthy();
    fireEvent.click(within(settings).getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    expect(s.of('admin_space_update')[0]).toEqual(expect.objectContaining({ slug: 'shared', executable: true }));
    expect(s.of('admin_space_update')[0]).not.toHaveProperty('review_mode');
    expect(s.of('admin_space_update')[0]).not.toHaveProperty('protected_paths');
    fireEvent.click(within(settings).getByRole('radio', { name: /^Require approval/ }));
    change(within(settings).getByLabelText('Who needs approval'), 'all');
    fireEvent.click(within(settings).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(s.of('admin_space_update')[1]).toEqual(expect.objectContaining({ review_mode: 'all', executable: false })));
    cleanup();

    // A combination that is no preset: Custom, Advanced open, saved back unchanged.
    const s2 = adminServer();
    Object.assign(s2.state.spaces[0]!, { review_mode: 'limited', executable: true });
    renderAt('/s/shared/settings');
    const f2 = await screen.findByRole('form', { name: 'Settings' });
    expect((within(f2).getByRole('radio', { name: /^Custom/ }) as HTMLInputElement).checked).toBe(true);
    expect((f2.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect((within(f2).getByLabelText('Approval required for') as HTMLSelectElement).value).toBe('limited');
    expect((within(f2).getByRole('checkbox', { name: /^Flag edits for attention/ }) as HTMLInputElement).checked).toBe(true);
    change(within(f2).getByLabelText('Description'), 'changed');
    fireEvent.click(within(f2).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(s2.of('admin_space_update')).toHaveLength(1));
    expect(s2.of('admin_space_update')[0]).toEqual(expect.objectContaining({ slug: 'shared', description: 'changed' }));
    expect(s2.of('admin_space_update')[0]).not.toHaveProperty('review_mode');
    expect(s2.of('admin_space_update')[0]).not.toHaveProperty('executable');
  });

  it('Settings: Advanced fields send only what changed; rename and archive in the Danger zone', async () => {
    const s = adminServer();
    s.state.spaces[0]!.ttl_days = 14;
    renderAt('/s/shared/settings');
    const settings = await screen.findByRole('form', { name: 'Settings' });
    change(within(settings).getByLabelText('Document TTL, days'), '');
    change(within(settings).getByLabelText('Quota, MB'), '100');
    change(within(settings).getByLabelText('Protected paths'), '');
    fireEvent.click(within(settings).getByRole('checkbox', { name: /^Messages: (on|off)/ }));
    fireEvent.click(within(settings).getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    const upd = s.of('admin_space_update')[0]!;
    expect(upd).toMatchObject({ slug: 'shared', ttl_days: null, quota_bytes: 100 * MB, protected_paths: [], inbox: true });
    expect(upd).not.toHaveProperty('name');
    expect(upd).not.toHaveProperty('review_mode');

    const rename = screen.getByRole('form', { name: 'Rename' });
    change(within(rename).getByLabelText('New slug'), 'common');
    fireEvent.click(within(rename).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(s.of('admin_space_update')[1]).toMatchObject({ slug: 'shared', new_slug: 'common' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Archive…' }));
    expect(s.of('admin_space_archive')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, archive' }));
    expect(await screen.findByRole('button', { name: 'Restore from archive' })).toBeTruthy();
    expect(s.of('admin_space_archive')[0]).toMatchObject({ slug: 'common' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore from archive' }));
    expect(await screen.findByRole('button', { name: 'Archive…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, archive' }));
    expect(await screen.findByRole('button', { name: 'Restore from archive' })).toBeTruthy();
    const archives = s.of('admin_space_archive');
    expect(archives).toHaveLength(2);
    expect(archives[0]!.request_id).not.toBe(archives[1]!.request_id);
  });

  it('a taken slug is a conflict in words', async () => {
    adminServer();
    renderAt('/new-space');
    const form = await screen.findByRole('form', { name: 'New space' });
    change(within(form).getByLabelText('Name'), 'Shared');
    fireEvent.click(within(form).getByRole('button', { name: 'Create space' }));
    expect(await within(form).findByText('This slug is already taken.')).toBeTruthy();
  });

  it('Notes for agents (AGENTS.md): create link when absent, edit and history links when present', async () => {
    adminServer();
    renderAt('/s/shared/settings');
    const create = await screen.findByRole('link', { name: 'Create AGENTS.md' });
    expect(create.getAttribute('href')).toBe('/s/shared/new?path=AGENTS.md');
    cleanup();

    adminServer({
      extra: {
        read: () => ({
          doc: { id: '01A', space: 'shared', path: 'AGENTS.md', kind: 'text', mime: 'text/markdown', title: 'AGENTS', rev: 3, content_hash: 'h', size: 1, updated_at: T, author: { name: 'alice', kind: 'human', trust: 'admin' }, trust_floor: 'admin', deleted: false },
          revision: { rev: 3 },
          encoding: 'utf8',
          truncated: false,
        }),
      },
    });
    renderAt('/s/shared/settings');
    expect((await screen.findByRole('link', { name: 'Edit AGENTS.md' })).getAttribute('href')).toBe('/s/shared/edit/AGENTS.md');
    expect(screen.getByRole('link', { name: 'History' }).getAttribute('href')).toBe('/s/shared/history/AGENTS.md');
    expect(screen.getByText('revision 3')).toBeTruthy();
  });

  it('old links: /admin/spaces → home, /admin/spaces/x → its Settings, /admin/access → People & agents; no Access matrix in the sidebar', async () => {
    adminServer();
    renderAt('/admin/spaces/shared');
    expect(await screen.findByRole('form', { name: 'Settings' })).toBeTruthy();
    const nav = within(screen.getByRole('complementary', { name: 'Navigation' }));
    expect(nav.queryByRole('link', { name: 'Access matrix' })).toBeNull();
    expect(nav.queryByRole('link', { name: /agent’s eyes/ })).toBeNull();
    cleanup();
    adminServer();
    renderAt('/admin/access');
    expect(await screen.findByRole('navigation', { name: 'People & agents sections' })).toBeTruthy();
  });

  it('new document page takes a ready path (AGENTS.md)', async () => {
    adminServer();
    renderAt('/s/shared/new?path=AGENTS.md');
    expect(((await screen.findByLabelText('Path in space shared')) as HTMLInputElement).value).toBe('AGENTS.md');
  });

  it('non-admins see no Members or Settings tab', async () => {
    const s = adminServer({ session: { name: 'carol', kind: 'human', trust: 'trusted', role: 'member', admin: false } });
    renderAt('/s/shared/members');
    expect(await screen.findByRole('heading', { name: 'Shared' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull();
    expect(s.calls.some((c) => c.op === 'admin_space_members')).toBe(false);
  });
});

describe('agents and tokens', () => {
  it('creates an agent with trust, harness and manager, then opens its page', async () => {
    const s = adminServer();
    renderAt('/admin/agents');
    fireEvent.click(await screen.findByRole('button', { name: 'Add agent' }));
    const form = screen.getByRole('form', { name: 'New agent' });
    expect(within(form).queryByLabelText('Kind')).toBeNull();
    expect((within(form).getByLabelText('Manager') as HTMLSelectElement).value).toBe('alice');
    change(within(form).getByLabelText('Name'), 'alice-coder');
    change(within(form).getByLabelText('Trust'), 'limited');
    const harness = within(form).getByLabelText('Harness') as HTMLSelectElement;
    expect(harness.tagName).toBe('SELECT');
    expect([...harness.options].map((o) => o.text)).toEqual(['not set', 'Claude Code', 'Codex', 'Connectome', 'Hermes', 'Letta', 'OpenClaw', 'Script/cron', 'Other…']);
    change(harness, 'letta');
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/Agent alice-coder created/)).toBeTruthy();
    expect(s.of('admin_principal_create')[0]).toMatchObject({ name: 'alice-coder', kind: 'agent', trust: 'limited', harness: 'letta', owner: 'alice' });
    expect(s.of('admin_principal_create')[0]).not.toHaveProperty('admin');
    expect(screen.getByRole('heading', { name: 'alice-coder' })).toBeTruthy();
  });

  it('creates an external agent with its owner label (trust limited by default)', async () => {
    const s = adminServer({
      extra: {
        admin_principal_create: (i) => {
          const p = mkPrincipal(String(i.name), {
            trust: i.trust as AdminPrincipal['trust'],
            external: { owner_label: (i.owner_label as string) ?? null, limits: { msgs_per_day: 20, body_bytes: 8192, pending_per_recipient: 5, token_days: 30 }, sent_today: 0 },
          });
          s.state.principals.push(p);
          return { principal: p };
        },
      },
    });
    renderAt('/admin/agents');
    fireEvent.click(await screen.findByRole('button', { name: 'Add agent' }));
    const form = screen.getByRole('form', { name: 'New agent' });
    change(within(form).getByLabelText('Name'), 'friend-bot');
    // One Manager field: "someone outside Brain" makes the agent external and asks for the name.
    expect(within(form).queryByLabelText('Manager’s name (outside Brain)')).toBeNull();
    change(within(form).getByLabelText('Manager'), '__outside');
    expect(within(form).queryByText(/Owner/)).toBeNull();
    change(within(form).getByLabelText('Manager’s name (outside Brain)'), 'Erin');
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/Agent friend-bot created/)).toBeTruthy();
    expect(s.of('admin_principal_create')[0]).toMatchObject({ name: 'friend-bot', kind: 'agent', trust: 'limited', external: true, owner_label: 'Erin' });
    expect(s.of('admin_principal_create')[0]).not.toHaveProperty('owner');
    expect(screen.getAllByText('external').length).toBeGreaterThan(0);
    // Overview: the Manager is the outside person.
    expect(await screen.findByText('Erin')).toBeTruthy();
  });

  it('an external agent page shows sent today and edits limits (empty = no limit)', async () => {
    const s = adminServer();
    s.state.principals.push(
      mkPrincipal('friend-bot', {
        trust: 'limited',
        external: { owner_label: 'Erin', limits: { msgs_per_day: 20, body_bytes: 8192, pending_per_recipient: 5, token_days: 30 }, sent_today: 3 },
      }),
    );
    renderAt('/admin/agents/friend-bot/advanced');
    const box = await screen.findByRole('form', { name: 'External agent' });
    expect(within(box).getByText('Sent today: 3 of 20')).toBeTruthy();
    change(within(box).getByLabelText('Messages per day'), '100');
    change(within(box).getByLabelText('Open per recipient'), '');
    fireEvent.click(within(box).getByRole('button', { name: 'Save limits' }));
    expect(await within(box).findByText('Limits saved.')).toBeTruthy();
    expect(s.of('admin_principal_update')[0]).toEqual(expect.objectContaining({ name: 'friend-bot', limits: { msgs_per_day: 100, pending_per_recipient: null } }));
    expect(s.of('admin_principal_update')[0]).not.toHaveProperty('owner_label');
  });

  it('a token is shown once: after hiding it is gone from the page; each issue is a new request; last_used and revoke', async () => {
    const s = adminServer();
    s.state.tokens.push({
      id: '01Told',
      principal: 'alice-helper',
      prefix: 'brn_oldoldol',
      label: 'laptop',
      created_at: T,
      expires_at: '2027-02-12T00:00:00.000Z',
      revoked: false,
      revoked_at: null,
      last_used_at: '2026-11-13T10:00:00.000Z',
      last_used_ip: '10.0.0.7',
    });
    renderAt('/admin/agents/alice-helper/connection');
    const tokens = await screen.findByRole('list', { name: 'Tokens' });
    expect(within(tokens).getByText(/last_used: .*10\.0\.0\.7/)).toBeTruthy();
    expect(within(tokens).getByText('active')).toBeTruthy();

    const issue = screen.getByRole('form', { name: 'Issue token' });
    change(within(issue).getByLabelText('Label'), 'Hermes on Pi');
    change(within(issue).getByLabelText('Expires'), 'never');
    fireEvent.click(within(issue).getByRole('button', { name: 'Issue token' }));
    const shown = await screen.findByLabelText('New token');
    const token = shown.textContent!;
    expect(token).toMatch(/^brn_k+1$/);
    expect(s.of('admin_token_issue')[0]).toMatchObject({ principal: 'alice-helper', label: 'Hermes on Pi', days: null });
    // The instructions with this token are right here, once.
    expect(screen.getByText(/export BRAIN_TOKEN=brn_k+1/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'I saved the token, hide it' }));
    expect(document.body.textContent).not.toContain(token);
    // The list shows only the prefix; the instructions have no token.
    expect(await within(screen.getByRole('list', { name: 'Tokens' })).findByText('Hermes on Pi')).toBeTruthy();
    expect(screen.getByLabelText('Guide text').textContent).toContain('/mcp/v1');
    expect(screen.getByLabelText('Guide text').textContent).not.toContain('brn_k');

    // The second token gets a new request_id (repeating the old one would return "already issued").
    fireEvent.click(within(screen.getByRole('form', { name: 'Issue token' })).getByRole('button', { name: 'Issue token' }));
    await screen.findByLabelText('New token');
    const [a, b] = s.of('admin_token_issue');
    expect(a!.request_id).not.toBe(b!.request_id);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke token laptop' }));
    expect(s.of('admin_token_revoke')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke brn_oldoldol…' }));
    expect(await screen.findByText(/Token revoked/)).toBeTruthy();
    expect(s.of('admin_token_revoke')[0]).toMatchObject({ id: '01Told' });
    expect(await within(screen.getByRole('list', { name: 'Tokens' })).findByText('revoked')).toBeTruthy();
  });

  it('connect instruction comes from admin_connect_guide; the server picks the recorded harness', async () => {
    const s = adminServer();
    renderAt('/admin/agents/alice-helper/connection');
    expect((await screen.findByLabelText('Guide text')).textContent).toContain('Connect alice-helper to Brain from hermes');
    expect(s.of('admin_connect_guide')[0]).toEqual({ principal: 'alice-helper' });
  });

  it('a failing admin_connect_guide shows the error, not a made-up instruction', async () => {
    adminServer({
      extra: {
        admin_connect_guide: () => {
          throw new Fail(500, 'internal');
        },
      },
    });
    renderAt('/admin/agents/alice-helper/connection');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByLabelText('Guide text')).toBeNull();
  });

  it('Advanced: trust and the one "Brain administrator" checkbox (only a superadmin changes it); harness on Overview', async () => {
    const s = adminServer();
    renderAt('/admin/agents/alice-helper/advanced');
    const adv = await screen.findByRole('form', { name: 'Advanced' });
    change(within(adv).getByLabelText('Trust'), 'admin');
    fireEvent.click(within(adv).getByRole('checkbox', { name: /^Brain administrator/ }));
    fireEvent.click(within(adv).getByRole('button', { name: 'Save' }));
    expect(await within(adv).findByText('Saved.')).toBeTruthy();
    expect(s.of('admin_principal_update')[0]).toEqual(expect.objectContaining({ name: 'alice-helper', trust: 'admin', admin: true }));
    expect(screen.queryByText(/capability/i)).toBeNull();
    cleanup();

    const s2 = adminServer();
    renderAt('/admin/agents/alice-helper');
    const edit = await screen.findByRole('form', { name: 'Edit' });
    change(within(edit).getByLabelText('Harness'), '');
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(s2.of('admin_principal_update')[0]).toEqual(expect.objectContaining({ name: 'alice-helper', harness: null })));
    cleanup();

    adminServer({ session: { name: 'alice-assistant', kind: 'agent', trust: 'admin', role: 'member', admin: true } });
    renderAt('/admin/agents/alice-helper/advanced');
    const adv2 = await screen.findByRole('form', { name: 'Advanced' });
    expect(within(adv2).queryByRole('checkbox')).toBeNull();
    expect(within(adv2).getByText('Not a Brain administrator.')).toBeTruthy();
    cleanup();

    // Superadmin is shown once, on the owner's own account.
    adminServer();
    renderAt('/admin/agents/alice');
    expect(await screen.findByText('Superadmin')).toBeTruthy();
  });

  it('Overview: profile, Manager → External (a human changes it), status, last seen; legacy card suggestions are used only on request', async () => {
    const s = adminServer();
    s.state.cards['alice-helper'] = [{ space: 'handoff', path: '_agents/alice-helper.md', doc_id: '01C', rev: 2, what_i_do: 'Runs errands for Alice.', contact: 'handoff_send', response_times: 'within an hour' }];
    renderAt('/admin/agents/alice-helper');
    expect((await screen.findAllByText('What it does')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('not filled in').length).toBe(2);
    expect(screen.getByText('Last seen')).toBeTruthy();
    const card = await screen.findByRole('region', { name: 'From its agent card' });
    expect(within(card).getByText('Runs errands for Alice.')).toBeTruthy();
    expect(s.of('admin_principal_update')).toHaveLength(0);
    fireEvent.click(within(card).getByRole('button', { name: 'Use these' }));
    await waitFor(() => expect(s.of('admin_principal_update')[0]).toEqual(expect.objectContaining({ name: 'alice-helper', what_i_do: 'Runs errands for Alice.', contact: 'handoff_send within an hour' })));
    // Manager → someone outside Brain makes it External.
    const edit = screen.getByRole('form', { name: 'Edit' });
    change(within(edit).getByLabelText('Manager'), '__outside');
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(within(edit).getByRole('alert').textContent).toMatch(/Name the person outside Brain/);
    change(within(edit).getByLabelText('Manager’s name (outside Brain)'), 'Erin');
    change(within(edit).getByLabelText('What it does'), 'Errands.');
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(s.of('admin_principal_update')[1]).toEqual(expect.objectContaining({ name: 'alice-helper', external: true, owner_label: 'Erin', what_i_do: 'Errands.' })));
  });

  it('Access: one line per space in plain words, "Why?" shows the rules; /admin/explain lands here', async () => {
    const s = adminServer();
    s.state.spaces.push(mkSpace('handoff', { name: 'General', inbox: true }), mkSpace('proj-beta', { name: 'Beta' }));
    s.state.grants.push(
      { id: '01R1', space: 'shared', scope: 'space', path_prefix: null, doc_id: null, subject: { type: 'principal', name: 'alice-helper' }, role: 'write', granted_by: 'alice', granted_at: T },
      { id: '01R2', space: 'handoff', scope: 'space', path_prefix: null, doc_id: null, subject: { type: 'principal', name: 'alice-helper' }, role: 'guest', granted_by: 'alice', granted_at: T },
    );
    renderAt('/admin/explain?principal=alice-helper');
    const list = within(await screen.findByRole('list', { name: 'Spaces (2)' }));
    expect(list.getByText('Shared — Editor')).toBeTruthy();
    expect(list.getByText('General — Guest: its own messages only')).toBeTruthy();
    fireEvent.click(list.getAllByText('Why?')[0]!);
    expect(list.getByText('whole space · alice-helper → Editor')).toBeTruthy();
    expect(screen.getByText('Does not see (1)')).toBeTruthy();
    // Add to a space: a ladder role.
    const add = screen.getByRole('form', { name: 'Add to a space' });
    change(within(add).getByLabelText('Space'), 'proj-beta');
    change(within(add).getByLabelText('Role'), 'viewer');
    fireEvent.click(within(add).getByRole('button', { name: 'Add to a space' }));
    await waitFor(() => expect(s.of('admin_grant_set')[0]).toMatchObject({ space: 'proj-beta', scope: 'space', subject: { type: 'principal', name: 'alice-helper' }, role: 'read' }));
  });

  it('disable takes two clicks; enable brings it back', async () => {
    const s = adminServer();
    renderAt('/admin/agents/alice-helper');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disable alice-helper' }));
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    expect(await screen.findByRole('button', { name: 'Disable agent' })).toBeTruthy();
    expect(s.of('admin_principal_disable')).toHaveLength(1);
    expect(s.of('admin_principal_enable')).toHaveLength(1);
  });

  it('disable → enable → disable sends three different request_ids and disables again', async () => {
    const s = adminServer();
    renderAt('/admin/agents/alice-helper');
    const disable = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Disable agent' }));
      fireEvent.click(screen.getByRole('button', { name: 'Yes, disable alice-helper' }));
      expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy();
    };
    await disable();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    expect(await screen.findByRole('button', { name: 'Disable agent' })).toBeTruthy();
    await disable();
    const ids = [s.of('admin_principal_disable')[0]!.request_id, s.of('admin_principal_enable')[0]!.request_id, s.of('admin_principal_disable')[1]!.request_id];
    expect(new Set(ids).size).toBe(3);
    // The server's replay didn't substitute the action: the agent really is disabled.
    expect(s.state.principals.find((p) => p.name === 'alice-helper')!.disabled).toBe(true);
  });

  it('a retry after a network failure keeps the request_id', async () => {
    const s = adminServer();
    s.dropNext.add('admin_principal_disable');
    renderAt('/admin/agents/alice-helper');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disable alice-helper' }));
    await waitFor(() => expect(s.of('admin_principal_disable')).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Yes, disable alice-helper' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disable alice-helper' }));
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy();
    const [a, b] = s.of('admin_principal_disable');
    expect(a!.request_id).toBe(b!.request_id);
  });
});

describe('tabs, Manager, inactive hidden and never in pickers', () => {
  const world = () => {
    const s = adminServer();
    s.state.principals.push(
      mkPrincipal('bob', { kind: 'human', owner: null, display_name: 'Bob' }),
      mkPrincipal('dave', { kind: 'human', owner: null, disabled: true, disabled_at: T }),
      mkPrincipal('alice-project-agent', { owner: 'bob', display_name: 'Alphabot', harness: 'cron' }),
      mkPrincipal('old-scraper', { disabled: true, disabled_at: T }),
    );
    s.state.groups.push({ id: '01Gcur', name: 'curators', description: '', system: false, members: ['alice-helper', 'old-scraper'] });
    s.state.spaces.push(mkSpace('old-wiki', { name: 'Old wiki', archived: true, archived_at: T }));
    return s;
  };

  it('Agents | People | Groups tabs (agents by default); disabled hidden behind “Show disabled”; Manager, not owner', async () => {
    world();
    renderAt('/admin/agents');
    const tabs = within(await screen.findByRole('navigation', { name: 'People & agents sections' }));
    expect(tabs.getByRole('link', { name: 'Agents' }).getAttribute('aria-current')).toBe('page');
    expect(tabs.getByRole('link', { name: 'People' }).getAttribute('href')).toBe('/admin/agents?tab=people');
    expect(tabs.getByRole('link', { name: 'Groups' }).getAttribute('href')).toBe('/admin/groups');
    const main = within(screen.getByRole('main'));
    await main.findByRole('link', { name: 'Alphabot' });
    // Agents only; no people in this list, no default badges.
    expect(main.queryByRole('link', { name: 'Bob' })).toBeNull();
    expect(main.queryByText('trusted')).toBeNull();
    expect(main.queryByText(/harness/)).toBeNull();
    expect(main.queryByText(/owner/i)).toBeNull();
    expect(main.getByText('managed by bob')).toBeTruthy();
    expect(main.queryByRole('link', { name: 'old-scraper' })).toBeNull();
    fireEvent.click(main.getByRole('checkbox', { name: 'Show disabled (1)' }));
    expect(await main.findByRole('link', { name: 'old-scraper' })).toBeTruthy();
    expect(main.getByText('disabled')).toBeTruthy();
    fireEvent.click(tabs.getByRole('link', { name: 'People' }));
    expect(await main.findByRole('link', { name: 'Bob' })).toBeTruthy();
    expect(main.queryByRole('link', { name: 'Alphabot' })).toBeNull();
    expect(main.queryByRole('link', { name: 'dave' })).toBeNull();
    expect(main.getByRole('button', { name: 'Add person' })).toBeTruthy();
  });

  it('agent page: Manager label and a known harness alias shown by name', async () => {
    world();
    renderAt('/admin/agents/alice-project-agent');
    const props = await screen.findByRole('form', { name: 'Edit' });
    const manager = within(props).getByLabelText('Manager') as HTMLSelectElement;
    expect(manager.value).toBe('bob');
    // Disabled people are not offered as a manager; "someone outside Brain" is.
    expect([...manager.options].map((o) => o.value)).toEqual(['', 'alice', 'bob', '__outside']);
    expect((within(props).getByLabelText('Harness') as HTMLSelectElement).value).toBe('script');
    expect(screen.getAllByText('Script/cron').length).toBeGreaterThan(1);
    expect(screen.queryByText(/Owner/)).toBeNull();
  });

  it('harness “Other…” opens a free-text field', async () => {
    const s = world();
    renderAt('/admin/agents/alice-helper');
    const props = await screen.findByRole('form', { name: 'Edit' });
    change(within(props).getByLabelText('Harness'), '__other');
    change(within(props).getByLabelText('Harness name'), 'my-own-loop');
    fireEvent.click(within(props).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(s.of('admin_principal_update')[0]).toMatchObject({ name: 'alice-helper', harness: 'my-own-loop' }));
  });

  it('group editor: only active people and agents can be added; a disabled member is greyed with “disabled — remove”', async () => {
    const s = world();
    renderAt('/admin/groups');
    const card = await screen.findByRole('listitem', { name: 'Group curators' });
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    expect(within(card).queryByRole('checkbox', { name: 'old-scraper' })).toBeNull();
    expect(within(card).queryByRole('checkbox', { name: 'dave' })).toBeNull();
    expect(within(card).getByRole('group', { name: 'Members: agents' })).toBeTruthy();
    expect(within(within(card).getByRole('group', { name: 'Members: people' })).getByRole('checkbox', { name: 'bob' })).toBeTruthy();
    const disabled = within(within(card).getByRole('list', { name: 'Disabled members' }));
    expect(disabled.getByText('old-scraper')).toBeTruthy();
    fireEvent.click(disabled.getByRole('button', { name: 'Remove disabled member old-scraper' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save group' }));
    await waitFor(() => expect(s.of('admin_group_members_set')[0]).toMatchObject({ name: 'curators', members: ['alice-helper'] }));
  });

  it('pickers offer no disabled principal and no archived space', async () => {
    world();
    renderAt('/admin/agents/alice-helper/access');
    const add = await screen.findByRole('form', { name: 'Add to a space' });
    await waitFor(() => expect(within(add).getByRole('option', { name: 'Shared' })).toBeTruthy());
    expect(within(add).queryByRole('option', { name: 'Old wiki' })).toBeNull();
    cleanup();
    world();
    renderAt('/s/shared/members');
    const picker = await screen.findByRole('combobox', { name: 'Person, agent or group' });
    fireEvent.focus(picker);
    const list = within(await screen.findByRole('listbox', { name: 'Person, agent or group' }));
    expect(list.getByText('Alphabot')).toBeTruthy();
    expect(list.queryByText('old-scraper')).toBeNull();
    expect(list.queryByText('dave')).toBeNull();
  });

  it('archived spaces: not in the sidebar; listed under Settings → Archived spaces', async () => {
    world();
    renderAt('/admin/settings');
    const section = await screen.findByRole('region', { name: 'Archived spaces' });
    expect((await within(section).findByRole('link', { name: 'Old wiki' })).getAttribute('href')).toBe('/s/old-wiki/settings');
    const nav = within(screen.getByRole('complementary', { name: 'Navigation' }));
    expect(nav.queryByRole('link', { name: 'Old wiki' })).toBeNull();
  });
});

describe('groups', () => {
  it('groups: create and set members; the system group is read-only', async () => {
    const s = adminServer();
    renderAt('/admin/groups');
    const create = await screen.findByRole('form', { name: 'New group' });
    change(within(create).getByLabelText('New group'), 'curators');
    fireEvent.click(within(create).getByRole('button', { name: 'Create group' }));
    const card = await screen.findByRole('listitem', { name: 'Group curators' });
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(card).getByRole('checkbox', { name: 'alice-helper' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save group' }));
    await waitFor(() => expect(s.of('admin_group_members_set')).toHaveLength(1));
    expect(s.of('admin_group_members_set')[0]).toMatchObject({ name: 'curators', members: ['alice-helper'] });
    const sys = screen.getByRole('listitem', { name: 'Group all-agents' });
    expect(within(sys).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

});

describe('settings: the start_here guide', () => {
  const DEFAULT = 'Brain is a shared document memory.';
  const settingsServer = () => {
    const st = { text: null as string | null };
    const out = () => ({ settings: { guide_text: st.text ?? DEFAULT, guide_text_is_default: st.text === null, guide_text_default: DEFAULT, guide_text_max: 1500 } });
    return adminServer({
      extra: {
        admin_settings_get: () => out(),
        admin_settings_update: (i) => {
          st.text = typeof i.guide_text === 'string' && i.guide_text.trim() ? i.guide_text : null;
          return out();
        },
      },
    });
  };

  it('shows the default, saves an edit, restores the default; over 1500 characters cannot be saved', async () => {
    const s = settingsServer();
    renderAt('/admin/settings');
    const box = (await screen.findByLabelText(/What this is/)) as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT);
    expect(screen.getByText('This is the built-in default text.')).toBeTruthy();
    change(box, 'Alice keeps project notes here.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(s.of('admin_settings_update')[0]).toMatchObject({ guide_text: 'Alice keeps project notes here.' });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore the default' }));
    await waitFor(() => expect(s.of('admin_settings_update')[1]).toMatchObject({ guide_text: null }));
    await waitFor(() => expect((screen.getByLabelText(/What this is/) as HTMLTextAreaElement).value).toBe(DEFAULT));
    change(screen.getByLabelText(/What this is/), 'x'.repeat(1501));
    expect(screen.getByRole('alert').textContent).toContain('At most 1500 characters.');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the sidebar links to Settings for an admin', async () => {
    settingsServer();
    renderAt('/');
    const nav = await screen.findByRole('complementary', { name: 'Navigation' });
    expect(within(nav).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/admin/settings');
  });
});

describe('Connect agent', () => {
  const TOKEN = 'brn_connectconnectconnectconnectconnectconne';
  function connectServer() {
    let connected = false;
    const s = adminServer({
      extra: {
        admin_agent_connect: (i) => {
          const p = mkPrincipal(String(i.name), { display_name: String(i.display_name), harness: String(i.harness) });
          s.state.principals.push(p);
          return {
            principal: p,
            token: TOKEN,
            info: { id: '01Tconn', principal: p.name, prefix: TOKEN.slice(0, 12), label: 'Connect agent', created_at: T, expires_at: null, revoked: false, revoked_at: null, last_used_at: null, last_used_ip: null },
            spaces: [{ slug: 'proj-alpha', role: 'write' }],
            bundle: {
              harness: i.harness,
              transport: 'http',
              server_url: 'https://brain.example',
              mcp_url: 'https://brain.example/mcp/v1',
              where: 'Run (add `--scope user` to use it in every project):',
              config: `claude mcp add --transport http brain https://brain.example/mcp/v1 --header "Authorization: Bearer ${TOKEN}"`,
              sentence: 'Connect to Brain (the MCP server "brain") and call start_here once; it tells you who you are and what to do next.',
              text: `# Connect ${p.name}\n${TOKEN}`,
              filename: `brain-${p.name}-claude-code.sh`,
            },
          };
        },
        admin_agent_connection: (i) => ({
          principal: i.name,
          token: { id: i.token_id, prefix: TOKEN.slice(0, 12), revoked: false, expired: false },
          connected,
          last_contact_at: connected ? T : null,
          sees: connected
            ? [
                { space: 'proj-alpha', name: 'Alpha', role: 'editor', messages_only: false, via: [] },
                { space: 'handoff', name: 'General', role: 'guest', messages_only: true, via: [] },
                { space: 'recipes', name: 'Recipes', role: 'viewer', messages_only: false, via: ['all-agents'] },
              ]
            : [],
          not_sees: connected
            ? { count: 1, probes: [{ space: 'proj-beta', name: 'Beta', canary: true, list: 'not_found', read: 'not_found', confirmed: true }], all_confirmed: true }
            : null,
        }),
      },
    });
    s.state.spaces.push(mkSpace('proj-alpha', { name: 'Alpha', inbox: true }), mkSpace('proj-beta', { name: 'Beta' }), mkSpace('old', { name: 'Old', archived: true, archived_at: T }));
    return { s, connect: () => (connected = true) };
  }

  it('name → handle, Manager, Harness; only ticked spaces with a role; the bundle once; Waiting → Connected → Sees / Does not see', async () => {
    const { s, connect } = connectServer();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/admin/agents']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Connect agent' }));
    const form = await screen.findByRole('form', { name: 'Connect agent' });
    change(within(form).getByLabelText('Display name'), 'Project agent');
    expect((within(form).getByLabelText('Handle') as HTMLInputElement).value).toBe('alice-project-agent');
    const harness = within(form).getByLabelText('Harness') as HTMLSelectElement;
    expect([...harness.options].map((o) => o.text)).toEqual(['Claude Code', 'Codex', 'Connectome', 'Hermes', 'Letta', 'Other MCP client (JSON)', 'Script / cron (inbox-poll.sh)']);
    // Spaces: active ones only, none ticked, no General added on its own.
    const list = await within(form).findByRole('list', { name: '2. Spaces and roles' });
    expect(within(list).queryByText('Old')).toBeNull();
    expect(within(list).getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(within(list).getByRole('checkbox', { name: /Alpha/ }));
    const role = within(list).getByLabelText('Role: Alpha') as HTMLSelectElement;
    expect(role.value).toBe('guest'); // messages on: Guest first
    change(role, 'editor');
    fireEvent.click(within(form).getByRole('button', { name: 'Create and show the config' }));

    expect(await screen.findByText(/Shown once/)).toBeTruthy();
    const sent = s.of('admin_agent_connect')[0]!;
    expect(sent).toMatchObject({ name: 'alice-project-agent', display_name: 'Project agent', owner: 'alice', harness: 'claude-code', transport: 'http', spaces: [{ space: 'proj-alpha', role: 'write' }] });
    expect(typeof sent.request_id).toBe('string');
    expect(screen.getByLabelText('Brain token').textContent).toBe(TOKEN);
    expect(screen.getByText(/claude mcp add --transport http brain/)).toBeTruthy();
    expect(screen.getByText(/call start_here once/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Download brain-alice-project-agent-claude-code\.sh/ })).toBeTruthy();
    // The bundle is in no query cache.
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(TOKEN);

    expect(await screen.findByText('Waiting for Project agent to connect…')).toBeTruthy();
    expect(screen.queryByText('Sees')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    connect();
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/Connected: Project agent called Brain/)).toBeTruthy();
    const sees = screen.getByRole('list', { name: 'Sees' });
    expect(sees.textContent).toContain('Alpha — Editor');
    expect(sees.textContent).toContain('General — Guest: its own messages only');
    expect(sees.textContent).toContain('Recipes — Viewer (through the group all-agents, not ticked here)');
    const not = screen.getByRole('list', { name: 'Does not see: 1 other space' });
    expect(not.textContent).toContain('Beta — not found — checked');
    expect(screen.getByText('Isolation checked.')).toBeTruthy();
    expect(s.of('admin_agent_connection').every((i) => i.token_id === '01Tconn')).toBe(true);
  });

  it('someone outside Brain as Manager: External, handle without a manager prefix, outside sent instead of owner', async () => {
    const { s } = connectServer();
    renderAt('/admin/connect-agent');
    const form = await screen.findByRole('form', { name: 'Connect agent' });
    change(within(form).getByLabelText('Manager'), '__outside');
    change(within(form).getByLabelText('Display name'), 'Erin Bot');
    expect((within(form).getByLabelText('Handle') as HTMLInputElement).value).toBe('erin-bot');
    fireEvent.click(within(form).getByRole('button', { name: 'Create and show the config' }));
    expect(await within(form).findByRole('alert')).toBeTruthy(); // the outside name is required
    change(within(form).getByLabelText('Manager’s name (outside Brain)'), 'Erin');
    fireEvent.click(within(form).getByRole('button', { name: 'Create and show the config' }));
    await screen.findByText(/Shown once/);
    const sent = s.of('admin_agent_connect')[0]!;
    expect(sent).toMatchObject({ name: 'erin-bot', outside: 'Erin', spaces: [] });
    expect(sent).not.toHaveProperty('owner');
  });
});
