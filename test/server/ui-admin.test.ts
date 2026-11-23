// The UI admin path over REST with a session: the same calls and headers that web/src/api/client.ts
// sends. Checks what the screens assume about the server: new space defaults, granting access and its
// effect from the next call, the token shown once, last_used, revocation, rename, archive, the matrix
// and overrides, "through the agent's eyes", groups; and that response shapes match the types in
// web/src/api/types.ts.
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

async function bearer<T = Record<string, unknown>>(token: string, name: string, input: unknown = {}) {
  const res = await fetch(`${h.url}/api/v1/ops/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as Env<T> };
}

const SPACE_KEYS = [
  'archived',
  'archived_at',
  'bytes_used',
  'created_at',
  'description',
  'executable',
  'id',
  'inbox',
  'max_doc_bytes',
  'name',
  'protected_paths',
  'quota_bytes',
  'review_mode',
  'slug',
  'trash_retention_days',
  'ttl_days',
];
const TOKEN_KEYS = ['created_at', 'expires_at', 'id', 'label', 'last_used_at', 'last_used_ip', 'prefix', 'principal', 'revoked', 'revoked_at'];

type Space = { slug: string; review_mode: string; protected_paths: string[]; quota_bytes: number; ttl_days: number | null; archived: boolean };
type Token = { id: string; prefix: string; revoked: boolean; last_used_at: string | null; expires_at: string | null };

describe('UI admin path over REST with a session cookie', () => {
  it('create space → grant all-agents → agent token shown once → agent sees it → last_used → revoke → 401', async () => {
    const cookie = await login();

    // The create form does not send empty fields: the server fills in the defaults.
    const created = await op<{ space: Space }>(cookie, 'admin_space_create', { slug: 'team-x', name: 'Project X', description: '', review_mode: 'off', executable: false, protected_paths: [], request_id: 'ui-req-space-create-1' });
    expect(created.status).toBe(200);
    expect(Object.keys(created.body.result.space).sort()).toEqual(SPACE_KEYS);
    expect(created.body.result.space).toMatchObject({ slug: 'team-x', review_mode: 'off', protected_paths: [], quota_bytes: 500 * 1024 * 1024, ttl_days: null, archived: false });
    // Replaying the same intent neither creates a second one nor fails.
    const again = await op<{ space: Space }>(cookie, 'admin_space_create', { slug: 'team-x', name: 'Project X', description: '', review_mode: 'off', executable: false, protected_paths: [], request_id: 'ui-req-space-create-1' });
    expect(again.body.result.space.slug).toBe('team-x');
    const taken = await op(cookie, 'admin_space_create', { slug: 'team-x', request_id: 'ui-req-space-create-2' });
    expect(taken.body.error).toMatchObject({ code: 'conflict', details: { reason: 'slug_taken' } });

    // Agent: creation and token.
    const agent = await op<{ principal: { name: string; trust: string; harness: string; owner: string; admin: boolean } }>(cookie, 'admin_principal_create', {
      name: 'alice-coder',
      kind: 'agent',
      trust: 'limited',
      harness: 'letta',
      owner: 'alice',
      request_id: 'ui-req-agent-create-1',
    });
    expect(agent.body.result.principal).toMatchObject({ name: 'alice-coder', trust: 'limited', harness: 'letta', owner: 'alice', admin: false });
    const issued = await op<{ token: string; info: Token }>(cookie, 'admin_token_issue', { principal: 'alice-coder', label: 'Letta on Pi', days: null, request_id: 'ui-req-token-issue-1' });
    expect(issued.body.result.token).toMatch(/^brn_[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(issued.body.result.info).sort()).toEqual(TOKEN_KEYS);
    expect(issued.body.result.info.expires_at).toBeNull();
    const token = issued.body.result.token;
    // A replay of the same request_id does not return the token, so the UI sends a new id on every click.
    const replay = await op(cookie, 'admin_token_issue', { principal: 'alice-coder', label: 'Letta on Pi', days: null, request_id: 'ui-req-token-issue-1' });
    expect(replay.body.error).toMatchObject({ code: 'conflict', details: { reason: 'token_already_issued' } });
    expect(JSON.stringify(replay.body)).not.toContain(token);

    // Until access is granted the agent cannot see the space.
    const before = await bearer<{ spaces: { slug: string }[] }>(token, 'spaces');
    expect(before.body.result.spaces.map((s) => s.slug)).not.toContain('team-x');
    const grant = await op<{ grant: { scope: string; role: string; subject: { type: string; name: string } } }>(cookie, 'admin_grant_set', {
      space: 'team-x',
      scope: 'space',
      subject: { type: 'group', name: 'all-agents' },
      role: 'write',
      request_id: 'ui-req-grant-1',
    });
    expect(grant.body.result.grant).toMatchObject({ scope: 'space', role: 'write', subject: { type: 'group', name: 'all-agents' } });
    // all-agents gives no access to proj-* (or inbox) spaces, so the grant is refused there.
    await op(cookie, 'admin_space_create', { slug: 'proj-x', name: 'Project X', request_id: 'ui-req-space-create-3' });
    const ambient = await op(cookie, 'admin_grant_set', { space: 'proj-x', scope: 'space', subject: { type: 'group', name: 'all-agents' }, role: 'read', request_id: 'ui-req-grant-2' });
    expect(ambient.body.error).toMatchObject({ code: 'invalid_input' });
    // From the next call it is visible and writable.
    const after = await bearer<{ spaces: { slug: string; role: string }[] }>(token, 'spaces');
    expect(after.body.result.spaces.find((s) => s.slug === 'team-x')).toMatchObject({ role: 'write' });
    const w = await bearer<{ status: string }>(token, 'write', { space: 'team-x', path: 'notes.md', content: '# Notes\n', expected_rev: 0, message: 'first' });
    expect(w.body.result.status).toBe('committed');

    // last_used shows in the token list; the token value is not in the list.
    const list = await op<{ tokens: Token[] }>(cookie, 'admin_token_list', { principal: 'alice-coder', include_revoked: true });
    expect(list.body.result.tokens).toHaveLength(1);
    expect(list.body.result.tokens[0]!.last_used_at).not.toBeNull();
    expect(list.body.result.tokens[0]!.prefix).toBe(token.slice(0, 12));
    expect(JSON.stringify(list.body)).not.toContain(token);

    // Revocation: 401 from the next request.
    const revoked = await op<{ token: Token }>(cookie, 'admin_token_revoke', { id: list.body.result.tokens[0]!.id, request_id: 'ui-req-token-revoke-1' });
    expect(revoked.body.result.token.revoked).toBe(true);
    expect((await bearer(token, 'whoami')).status).toBe(401);
  });

  it('settings diff, rename keeps id and grants, archive hides from agents and unarchive brings back', async () => {
    const cookie = await login();
    const listed = await op<{ spaces: (Space & { id: string })[] }>(cookie, 'admin_space_list', { include_archived: true });
    const shared = listed.body.result.spaces.find((s) => s.slug === 'shared')!;

    const upd = await op<{ space: Space }>(cookie, 'admin_space_update', { slug: 'shared', review_mode: 'limited', ttl_days: null, quota_bytes: 100 * 1024 * 1024, protected_paths: ['AGENTS.md'], request_id: 'ui-req-upd-1' });
    expect(upd.body.result.space).toMatchObject({ review_mode: 'limited', ttl_days: null, quota_bytes: 100 * 1024 * 1024, protected_paths: ['AGENTS.md'] });

    const ren = await op<{ space: Space & { id: string } }>(cookie, 'admin_space_update', { slug: 'shared', new_slug: 'common', request_id: 'ui-req-ren-1' });
    expect(ren.body.result.space).toMatchObject({ slug: 'common', id: shared.id });
    const grants = await op<{ grants: { space: string }[] }>(cookie, 'admin_grant_list', { space: 'common' });
    expect(grants.body.result.grants.length).toBeGreaterThan(0);

    // A space's AGENTS.md is an ordinary document: the screen reads meta; if absent, not_found.
    const meta = await op(cookie, 'read', { space: 'common', path: 'AGENTS.md', format: 'meta' });
    expect([200, 404]).toContain(meta.status);

    const arch = await op<{ space: Space }>(cookie, 'admin_space_archive', { slug: 'common', request_id: 'ui-req-arch-1' });
    expect(arch.body.result.space.archived).toBe(true);
    const visible = await op<{ spaces: Space[] }>(cookie, 'admin_space_list', { include_archived: false });
    expect(visible.body.result.spaces.map((s) => s.slug)).not.toContain('common');
    const explain = await op<{ spaces: { space: string; visible: boolean; archived: boolean }[] }>(cookie, 'admin_access_explain', { principal: 'alice-helper' });
    expect(explain.body.result.spaces.find((s) => s.space === 'common')).toMatchObject({ archived: true, visible: false });
    const un = await op<{ space: Space }>(cookie, 'admin_space_unarchive', { slug: 'common', request_id: 'ui-req-unarch-1' });
    expect(un.body.result.space.archived).toBe(false);
  });

  it('matrix and overrides: a folder "none" narrows read; explain names the deciding grant; remove restores; groups', async () => {
    const cookie = await login();
    await op(cookie, 'admin_space_create', { slug: 'proj-m', request_id: 'ui-req-m-1' });
    await op(cookie, 'admin_grant_set', { space: 'proj-m', scope: 'space', subject: { type: 'principal', name: 'alice-helper' }, role: 'read', request_id: 'ui-req-m-2' });
    await op(cookie, 'admin_grant_set', { space: 'proj-m', scope: 'path', path_prefix: 'private/', subject: { type: 'principal', name: 'alice-helper' }, role: 'none', request_id: 'ui-req-m-3' });

    const all = await op<{ grants: { space: string; scope: string; path_prefix: string | null; doc_id: string | null; role: string; subject: { type: string; name: string } }[] }>(cookie, 'admin_grant_list', {});
    // The creator (the superadmin here) gets admin on the new space automatically.
    const mine = all.body.result.grants.filter((g) => g.space === 'proj-m' && g.subject.name === 'alice-helper');
    expect(mine.map((g) => [g.scope, g.path_prefix, g.role]).sort()).toEqual([
      ['path', 'private/', 'none'],
      ['space', null, 'read'],
    ]);

    type Explain = { groups: string[]; spaces: { space: string; visible: boolean; role: string; target?: { role: string; level: string; decided_by: { scope: string; path_prefix: string }[] } }[] };
    const ex = await op<Explain>(cookie, 'admin_access_explain', { principal: 'alice-helper', space: 'proj-m', path: 'private/x.md' });
    expect(ex.body.result.groups).toContain('all-agents');
    const sp = ex.body.result.spaces.find((s) => s.space === 'proj-m')!;
    expect(sp).toMatchObject({ visible: true, role: 'read', target: { role: 'none', level: 'path' } });
    expect(sp.target!.decided_by[0]).toMatchObject({ scope: 'path', path_prefix: 'private/' });

    // "—" in the matrix removes the space-level right.
    const rm = await op(cookie, 'admin_grant_remove', { space: 'proj-m', scope: 'path', path_prefix: 'private/', subject: { type: 'principal', name: 'alice-helper' }, request_id: 'ui-req-m-4' });
    expect(rm.body.ok).toBe(true);
    const ex2 = await op<Explain>(cookie, 'admin_access_explain', { principal: 'alice-helper', space: 'proj-m', path: 'private/x.md' });
    expect(ex2.body.result.spaces.find((s) => s.space === 'proj-m')!.target).toMatchObject({ role: 'read', level: 'space' });

    const g = await op<{ group: { name: string; members: string[]; system: boolean } }>(cookie, 'admin_group_create', { name: 'reviewers', description: 'review', request_id: 'ui-req-g-1' });
    expect(g.body.result.group).toMatchObject({ name: 'reviewers', members: [], system: false });
    const set = await op<{ group: { members: string[] } }>(cookie, 'admin_group_members_set', { name: 'reviewers', members: ['alice-helper'], request_id: 'ui-req-g-2' });
    expect(set.body.result.group.members).toEqual(['alice-helper']);
    const sys = await op(cookie, 'admin_group_members_set', { name: 'all-agents', members: [], request_id: 'ui-req-g-3' });
    expect(sys.body.error).toMatchObject({ code: 'conflict', details: { reason: 'system_group' } });
  });

  it('admin_* without the admin capability look like a missing operation, also under a session', async () => {
    // An agent without the capability: no such operation.
    const cookie = await login();
    await op(cookie, 'admin_principal_create', { name: 'plain-agent', kind: 'agent', trust: 'trusted', request_id: 'ui-req-p-1' });
    const t = await op<{ token: string }>(cookie, 'admin_token_issue', { principal: 'plain-agent', request_id: 'ui-req-p-2' });
    const res = await bearer(t.body.result.token, 'admin_space_list', {});
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
    // admin_connect_guide under a session, the way the UI calls it: only the principal; the server picks the harness.
    const guide = await op<{ harness: string; text: string; mcp_url: string }>(cookie, 'admin_connect_guide', { principal: 'plain-agent' });
    expect(guide.status).toBe(200);
    expect(guide.body.result).toMatchObject({ harness: 'generic', mcp_url: `${h.config.origin}/mcp/v1` });
    expect(guide.body.result.text).toContain('plain-agent');
    expect(guide.body.result.text).not.toContain(t.body.result.token);
    // Without the admin capability the guide operation does not exist either.
    expect((await bearer(t.body.result.token, 'admin_connect_guide', { principal: 'plain-agent' })).status).toBe(404);
  });
});
