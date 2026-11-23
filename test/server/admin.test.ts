// Administrative operations over REST.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClient, type Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

interface Grant {
  id: string;
  space: string;
  scope: string;
  path_prefix: string | null;
  subject: { type: string; name: string };
  role: string;
}
interface Space {
  slug: string;
  role: string;
}

const spaceSlugs = async (c: Client) => (await c.call<{ spaces: Space[] }>('spaces')).spaces.map((s) => s.slug).sort();

async function expectCode(p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code, ...(details ? { details } : {}) });
}

describe('admin operations', () => {
  let h: Harness;
  let w: World;
  let alice: Client;
  let alphabot: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    alice = w.client('alice');
    alphabot = w.client('alphabot');
  });
  afterEach(async () => {
    await h.close();
  });

  it('for a caller without the admin capability every admin_* is indistinguishable from a missing operation', async () => {
    const missing = await alphabot.raw('no_such_operation', {});
    for (const op of ['admin_space_create', 'admin_grant_set', 'admin_token_issue', 'admin_access_explain', 'admin_principal_list']) {
      const r = await alphabot.raw(op, {});
      expect({ status: r.status, text: r.text }).toEqual({ status: missing.status, text: missing.text });
    }
  });

  it('spaces: create with defaults (review off, nothing protected), update, archive hides from all but superadmin', async () => {
    const created = await alice.call<{ space: { slug: string; review_mode: string; protected_paths: string[]; archived: boolean } }>(
      'admin_space_create',
      { slug: 'proj-new', name: 'New', description: 'd' },
    );
    expect(created.space).toMatchObject({ slug: 'proj-new', review_mode: 'off', protected_paths: [], archived: false });
    await expectCode(alice.call('admin_space_create', { slug: 'proj-new' }), 'conflict', { reason: 'slug_taken' });
    await expectCode(alice.call('admin_space_create', { slug: 'Bad Slug' }), 'invalid_input');

    await alice.call('admin_grant_set', { space: 'proj-new', scope: 'space', subject: { type: 'principal', name: 'alphabot' }, role: 'read' });
    expect(await spaceSlugs(alphabot)).toContain('proj-new');

    const upd = await alice.call<{ space: { slug: string; executable: boolean; ttl_days: number | null; protected_paths: string[] } }>(
      'admin_space_update',
      { slug: 'proj-new', new_slug: 'proj-renamed', executable: true, ttl_days: 7, protected_paths: ['AGENTS.md'] },
    );
    expect(upd.space).toMatchObject({ slug: 'proj-renamed', executable: true, ttl_days: 7, protected_paths: ['AGENTS.md'] });
    const seen = (await alphabot.call<{ spaces: (Space & { executable: boolean; ttl_days?: number; protected_paths: string[] })[] }>('spaces')).spaces.find(
      (s) => s.slug === 'proj-renamed',
    );
    expect(seen).toMatchObject({ role: 'read', executable: true, ttl_days: 7, protected_paths: ['AGENTS.md'] });

    await alice.call('admin_space_archive', { slug: 'proj-renamed' });
    expect(await spaceSlugs(alphabot)).not.toContain('proj-renamed');
    expect(await spaceSlugs(alice)).toContain('proj-renamed');
    const list = await alice.call<{ spaces: { slug: string }[] }>('admin_space_list', {});
    expect(list.spaces.map((s) => s.slug)).not.toContain('proj-renamed');
    const all = await alice.call<{ spaces: { slug: string; archived: boolean }[] }>('admin_space_list', { include_archived: true });
    expect(all.spaces.find((s) => s.slug === 'proj-renamed')?.archived).toBe(true);
    await alice.call('admin_space_unarchive', { slug: 'proj-renamed' });
    expect(await spaceSlugs(alphabot)).toContain('proj-renamed');
  });

  it('grant_set repeated on the same target replaces the role, no duplicate; read → none really revokes (A.1)', async () => {
    const key = { space: 'proj-beta', scope: 'space', subject: { type: 'principal', name: 'alphabot' } };
    const a = await alice.call<{ grant: Grant }>('admin_grant_set', { ...key, role: 'read' });
    const b = await alice.call<{ grant: Grant }>('admin_grant_set', { ...key, role: 'read' });
    expect(b.grant.id).toBe(a.grant.id);
    expect(await spaceSlugs(alphabot)).toContain('proj-beta');
    await alice.call('admin_grant_set', { ...key, role: 'none' });
    expect(await spaceSlugs(alphabot)).not.toContain('proj-beta');
    const list = await alice.call<{ grants: Grant[] }>('admin_grant_list', { space: 'proj-beta', subject: { type: 'principal', name: 'alphabot' } });
    expect(list.grants).toHaveLength(1);
    expect(list.grants[0]).toMatchObject({ role: 'none', scope: 'space' });

    // The folder prefix is normalised: "Drafts" and "drafts/" are the same key.
    const p1 = await alice.call<{ grant: Grant }>('admin_grant_set', { ...key, scope: 'path', path_prefix: 'Drafts', role: 'read' });
    const p2 = await alice.call<{ grant: Grant }>('admin_grant_set', { ...key, scope: 'path', path_prefix: 'drafts/', role: 'write' });
    expect(p2.grant.id).toBe(p1.grant.id);
    expect(p2.grant).toMatchObject({ path_prefix: 'drafts/', role: 'write' });
    const count = (h.core.db.prepare('SELECT count(*) AS n FROM grants WHERE subject_id = ?').get(w.principals.alphabot.id) as { n: number }).n;
    expect(count).toBe(5); // 3 from the world + space and path in proj-beta

    await alice.call('admin_grant_remove', { ...key, scope: 'path', path_prefix: 'drafts' });
    await expectCode(alice.call('admin_grant_remove', { ...key, scope: 'path', path_prefix: 'drafts' }), 'not_found');
    await expectCode(alice.call('admin_grant_set', { ...key, scope: 'path', role: 'read' }), 'invalid_input');
    await expectCode(alice.call('admin_grant_set', { ...key, scope: 'path', path_prefix: '../x', role: 'read' }), 'invalid_input');
    await expectCode(alice.call('admin_grant_set', { ...key, scope: 'doc', doc_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', role: 'read' }), 'not_found');
    await expectCode(alice.call('admin_grant_set', { ...key, space: 'no-such', role: 'read' }), 'not_found');
  });

  it('principals: create, update, list; disable cuts every token; last superadmin cannot be disabled', async () => {
    const created = await alice.call<{ principal: { name: string; kind: string; trust: string; admin: boolean; owner: string } }>(
      'admin_principal_create',
      { name: 'shop-agent', kind: 'agent', trust: 'limited', owner: 'alice', harness: 'letta' },
    );
    expect(created.principal).toMatchObject({ name: 'shop-agent', kind: 'agent', trust: 'limited', admin: false, owner: 'alice' });
    await expectCode(alice.call('admin_principal_create', { name: 'shop-agent', kind: 'agent', trust: 'limited' }), 'conflict', { reason: 'name_taken' });
    await expectCode(alice.call('admin_principal_create', { name: 'x-agent', kind: 'agent', trust: 'limited', password: 'long-enough-password' }), 'invalid_input');
    const upd = await alice.call<{ principal: { trust: string; harness: string | null } }>('admin_principal_update', { name: 'shop-agent', trust: 'trusted', harness: null });
    expect(upd.principal).toMatchObject({ trust: 'trusted', harness: null });
    const tok = await alice.call<{ token: string }>('admin_token_issue', { principal: 'shop-agent' });
    const carol = makeClient('rest', h, tok.token);
    expect((await carol.raw('whoami')).status).toBe(200);
    await alice.call('admin_principal_disable', { name: 'shop-agent' });
    expect((await carol.raw('whoami')).status).toBe(401);
    await expectCode(alice.call('admin_token_issue', { principal: 'shop-agent' }), 'conflict', { reason: 'principal_disabled' });
    const active = await alice.call<{ principals: { name: string }[] }>('admin_principal_list', {});
    expect(active.principals.map((p) => p.name)).not.toContain('shop-agent');
    expect(active.principals.map((p) => p.name)).not.toContain('system');
    const everyone = await alice.call<{ principals: { name: string; disabled: boolean }[] }>('admin_principal_list', { include_disabled: true });
    expect(everyone.principals.find((p) => p.name === 'shop-agent')?.disabled).toBe(true);
    await expectCode(alice.call('admin_principal_disable', { name: 'alice' }), 'conflict', { reason: 'last_superadmin' });
    await expectCode(alice.call('admin_principal_disable', { name: 'system' }), 'not_found');
  });

  it('tokens: issue returns the token once, list shows only the prefix, revoke works from the next request', async () => {
    const issued = await alice.call<{ token: string; info: { id: string; prefix: string; expires_at: string } }>('admin_token_issue', {
      principal: 'alphabot',
      label: 'second',
      days: 1,
    });
    expect(issued.token).toMatch(/^brn_[A-Za-z0-9_-]{43}$/);
    expect(issued.token.startsWith(issued.info.prefix)).toBe(true);
    const list = await alice.raw('admin_token_list', { principal: 'alphabot' });
    expect(list.text).not.toContain(issued.token);
    expect(list.text).toContain(issued.info.prefix);
    const none = await alice.call<{ token: string; info: { expires_at: string | null } }>('admin_token_issue', { principal: 'alphabot', days: null });
    expect(none.info.expires_at).toBeNull();
    const c = makeClient('rest', h, issued.token);
    expect((await c.raw('whoami')).status).toBe(200);
    await alice.call('admin_token_revoke', { id: issued.info.id });
    expect((await c.raw('whoami')).status).toBe(401);
    await alice.call('admin_token_revoke', { id: issued.info.id });
    await expectCode(alice.call('admin_token_revoke', { id: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }), 'not_found');
    const revoked = await alice.call<{ tokens: { id: string; revoked: boolean }[] }>('admin_token_list', { principal: 'alphabot', include_revoked: true });
    expect(revoked.tokens.find((t) => t.id === issued.info.id)?.revoked).toBe(true);
    expect(h.logs.join('')).not.toContain(issued.token);
  });

  it('groups: members_set applies from the next call; delete removes the group grants; all-agents is computed', async () => {
    await alice.call('admin_group_create', { name: 'beta-readers', description: 'test' });
    await alice.call('admin_grant_set', { space: 'proj-beta', scope: 'space', subject: { type: 'group', name: 'beta-readers' }, role: 'read' });
    expect(await spaceSlugs(alphabot)).not.toContain('proj-beta');
    const g = await alice.call<{ group: { members: string[] } }>('admin_group_members_set', { name: 'beta-readers', members: ['alphabot', 'alice-helper'] });
    expect(g.group.members).toEqual(['alice-helper', 'alphabot']);
    expect(await spaceSlugs(alphabot)).toContain('proj-beta');
    await alice.call('admin_group_members_set', { name: 'beta-readers', members: ['alice-helper'] });
    expect(await spaceSlugs(alphabot)).not.toContain('proj-beta');
    await alice.call('admin_group_members_set', { name: 'beta-readers', members: ['alphabot'] });
    await alice.call('admin_group_update', { name: 'beta-readers', new_name: 'beta-team', description: 'renamed' });
    await alice.call('admin_group_delete', { name: 'beta-team' });
    expect(await spaceSlugs(alphabot)).not.toContain('proj-beta');
    expect((await alice.call<{ grants: Grant[] }>('admin_grant_list', { space: 'proj-beta' })).grants.map((x) => x.subject.name)).toEqual(['betabot']);

    const groups = await alice.call<{ groups: { name: string; system: boolean; members: string[] }[] }>('admin_group_list', {});
    const all = groups.groups.find((x) => x.name === 'all-agents');
    expect(all?.system).toBe(true);
    expect(all?.members.sort()).toEqual(['alice-assistant', 'alice-helper', 'alphabot', 'betabot']);
    await expectCode(alice.call('admin_group_members_set', { name: 'all-agents', members: ['alphabot'] }), 'conflict', { reason: 'system_group' });
    await expectCode(alice.call('admin_group_delete', { name: 'all-agents' }), 'conflict', { reason: 'system_group' });
    await expectCode(alice.call('admin_group_members_set', { name: 'curators', members: ['ghost'] }), 'not_found');
  });

  it('access_explain shows what a principal sees and by which grant', async () => {
    w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'private/' });
    const r = await alice.call<{
      groups: string[];
      spaces: { space: string; visible: boolean; role: string; grants: Grant[]; target?: { role: string; level: string; decided_by: Grant[] } }[];
    }>('admin_access_explain', { principal: 'alphabot' });
    expect(r.groups).toEqual(['all-agents']);
    const bySlug = Object.fromEntries(r.spaces.map((s) => [s.space, s]));
    expect(bySlug['proj-beta']).toMatchObject({ visible: false, role: 'none', grants: [] });
    expect(bySlug.recipes).toMatchObject({ visible: true, role: 'read' });
    expect(bySlug.recipes!.grants[0]!.subject).toEqual({ type: 'group', name: 'all-agents' });
    const t = await alice.call<typeof r>('admin_access_explain', { principal: 'alphabot', space: 'shared', path: 'private/plan.md' });
    expect(t.spaces).toHaveLength(1);
    expect(t.spaces[0]!.target).toMatchObject({ role: 'none', level: 'path' });
    expect(t.spaces[0]!.target!.decided_by[0]).toMatchObject({ path_prefix: 'private/', role: 'none' });
    await expectCode(alice.call('admin_access_explain', { principal: 'alphabot', path: 'x.md' }), 'invalid_input');
  });

  it('idempotency: same request_id replays, different input → idempotency_mismatch (A.4)', async () => {
    const input = { name: 'replay-group', description: 'x', request_id: 'req-00000001' };
    const a = await alice.raw('admin_group_create', input);
    const b = await alice.raw('admin_group_create', input);
    expect(b.text).toBe(a.text);
    const r = await alice.raw('admin_group_create', { ...input, description: 'y' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'idempotency_mismatch' } });
    // The same request_id with a different operation is a mismatch too.
    expect((await alice.raw('admin_group_delete', { name: 'replay-group', request_id: 'req-00000001' })).status).toBe(409);
    // An error is not stored: after a conflict the same request_id runs again.
    await alice.call('admin_space_create', { slug: 'dup-space' });
    expect((await alice.raw('admin_space_create', { slug: 'dup-space', request_id: 'req-00000002' })).status).toBe(409);
    await alice.call('admin_space_update', { slug: 'dup-space', new_slug: 'dup-space-2' });
    expect((await alice.raw('admin_space_create', { slug: 'dup-space', request_id: 'req-00000002' })).status).toBe(200);
  });

  it('admin_token_issue does not store the token: a repeat answers conflict token_already_issued, no second token (A.4)', async () => {
    const input = { principal: 'alphabot', label: 'once', request_id: 'tok-00000001' };
    const first = await alice.call<{ token: string }>('admin_token_issue', input);
    const again = await alice.raw('admin_token_issue', input);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'token_already_issued' } } });
    expect(again.text).not.toContain(first.token);
    const stored = h.core.db.prepare('SELECT response FROM idempotency WHERE request_id = ?').get('tok-00000001') as { response: string };
    expect(stored.response).not.toContain(first.token);
    expect(stored.response).not.toContain('brn_');
    const labelled = (h.core.db.prepare("SELECT count(*) AS n FROM tokens WHERE label = 'once'").get() as { n: number }).n;
    expect(labelled).toBe(1);
  });
});

describe('admin capability for an agent', () => {
  let h: Harness;
  let w: World;
  beforeEach(async () => {
    h = await startHarness({ env: { BRAIN_BOOTSTRAP_ADMIN_AGENT: 'alice-assistant' } });
    w = buildWorld(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('the bootstrap admin agent gets the capability; others do not', async () => {
    expect((await w.client('alice-assistant').call<{ capabilities: string[] }>('whoami')).capabilities).toEqual(['admin']);
    expect((await w.client('alphabot').call<{ capabilities: string[] }>('whoami')).capabilities).toEqual([]);
    expect((await w.client('alice').call<{ capabilities: string[] }>('whoami')).capabilities).toEqual(['admin']);
  });

  it('an admin agent manages spaces, grants and agent tokens', async () => {
    const claude = w.client('alice-assistant');
    await claude.call('admin_space_create', { slug: 'proj-x' });
    await claude.call('admin_grant_set', { space: 'proj-x', scope: 'space', subject: { type: 'principal', name: 'alphabot' }, role: 'write' });
    expect((await w.client('alphabot').call<{ spaces: Space[] }>('spaces')).spaces.find((s) => s.slug === 'proj-x')?.role).toBe('write');
    const t = await claude.call<{ token: string; info: { id: string } }>('admin_token_issue', { principal: 'alphabot' });
    await claude.call('admin_token_revoke', { id: t.info.id });
    await claude.call('admin_principal_disable', { name: 'alice-helper' });
    await claude.call('admin_principal_enable', { name: 'alice-helper' });
  });

  it('an admin agent cannot touch a superadmin or hand out the admin capability', async () => {
    const claude = w.client('alice-assistant');
    await expectCode(claude.call('admin_principal_disable', { name: 'alice' }), 'forbidden');
    await expectCode(claude.call('admin_principal_update', { name: 'alice', trust: 'limited' }), 'forbidden');
    await expectCode(claude.call('admin_token_issue', { principal: 'alice' }), 'forbidden');
    await expectCode(claude.call('admin_token_revoke', { id: w.tokenIds.alice }), 'forbidden');
    await expectCode(claude.call('admin_principal_update', { name: 'alphabot', admin: true }), 'forbidden');
    await expectCode(claude.call('admin_principal_create', { name: 'evil', kind: 'agent', trust: 'admin', admin: true }), 'forbidden');
    // A superadmin can grant and revoke the capability.
    const alice = w.client('alice');
    await alice.call('admin_principal_update', { name: 'alphabot', admin: true });
    expect((await w.client('alphabot').call<{ capabilities: string[] }>('whoami')).capabilities).toEqual(['admin']);
    await alice.call('admin_principal_update', { name: 'alphabot', admin: false });
    expect((await w.client('alphabot').raw('admin_principal_list', {})).status).toBe(404);
  });

  it('the capability is applied at bootstrap to an already existing agent', async () => {
    await h.close();
    h = await startHarness();
    w = buildWorld(h);
    expect((await w.client('alice-assistant').call<{ capabilities: string[] }>('whoami')).capabilities).toEqual([]);
    const { bootstrap } = await import('../../src/core/bootstrap.js');
    bootstrap(h.core.db, h.config.tenant, Date.now(), 'alice-assistant');
    expect((await w.client('alice-assistant').call<{ capabilities: string[] }>('whoami')).capabilities).toEqual(['admin']);
  });
});
