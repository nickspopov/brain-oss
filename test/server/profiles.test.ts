// One profile per agent or person. Your own profile in full; a co-member's
// minimal profile only while you share a space (Alpha↛Beta canary on profiles and the To picker); legacy
// `_agents/<name>.md` cards keep working as documents and only *suggest* profile fields; External is
// changed by a human only.
import { afterEach, describe, expect, it } from 'vitest';
import { removeGrant } from '../../src/core/grants.js';
import { ApiError, type Client, type RawResponse } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

afterEach(async () => {
  await h?.close();
});

interface Profile {
  name: string;
  display_name: string;
  kind: string;
  what_i_do: string | null;
  contact: string | null;
  manager: string | null;
  external: boolean;
  active_today: boolean;
  harness?: string | null;
  last_seen?: string | null;
}
type ProfileOut = { profile: Profile; self: boolean };

async function err(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an error');
}
const errShape = (r: RawResponse): string => JSON.stringify({ status: r.status, error: (JSON.parse(r.text) as { error?: unknown }).error });
async function sameAsMissing(c: Client, name: string): Promise<void> {
  const a = await c.raw('profile_get', { name });
  const b = await c.raw('profile_get', { name: 'no-such-agent' });
  expect(a.status).toBe(404);
  expect(errShape(a).replace(name, 'X')).toBe(errShape(b).replace('no-such-agent', 'X'));
}

async function world(): Promise<void> {
  h = await startHarness();
  w = buildWorld(h);
}

describe('profile_get / profile_update', () => {
  it('fills in and reads its own profile; co-members get the minimal profile only; bad input is refused', async () => {
    await world();
    const alphabot = w.client('alphabot');
    const mine = await alphabot.call<ProfileOut>('profile_update', { what_i_do: 'Builds the Alpha app.', contact: 'handoff_send to alphabot; replies within a day' });
    expect(mine.self).toBe(true);
    expect(mine.profile).toMatchObject({ name: 'alphabot', what_i_do: 'Builds the Alpha app.', contact: 'handoff_send to alphabot; replies within a day', manager: 'Alice' });
    expect(mine.profile).toHaveProperty('harness');
    const own = await alphabot.call<ProfileOut>('profile_get', {});
    expect(own.profile.what_i_do).toBe('Builds the Alpha app.');
    // betabot shares shared and General with alphabot: the minimal profile — no harness, no last seen.
    const seen = await w.client('betabot').call<ProfileOut>('profile_get', { name: 'alphabot' });
    expect(seen.self).toBe(false);
    expect(Object.keys(seen.profile).sort()).toEqual(['active_today', 'contact', 'display_name', 'external', 'kind', 'manager', 'name', 'what_i_do']);
    expect(seen.profile.active_today).toBe(true);
    // Input rules: one line, length, no secrets, something to change.
    expect((await err(alphabot.call('profile_update', { what_i_do: 'two\nlines' }))).code).toBe('invalid_input');
    expect((await err(alphabot.call('profile_update', { what_i_do: 'x'.repeat(201) }))).code).toBe('invalid_input');
    expect((await err(alphabot.call('profile_update', { contact: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }))).code).toBe('secret_detected');
    expect((await err(alphabot.call('profile_update', {}))).code).toBe('invalid_input');
    // Clearing a field.
    expect((await alphabot.call<ProfileOut>('profile_update', { contact: null })).profile.contact).toBeNull();
    // Over MCP too, for every agent (a read-only one included).
    const mcp = w.client('alice-helper', 'mcp');
    const r = await mcp.call<ProfileOut>('profile_update', { what_i_do: 'Runs errands.' });
    expect(r.profile.what_i_do).toBe('Runs errands.');
  });

  it('the To picker (handoff_recipients) shows the profile line; Members shows it to admins', async () => {
    await world();
    await w.client('alphabot').call('profile_update', { what_i_do: 'Builds the Alpha app.' });
    const rec = await w.client('alice').call<{ recipients: { name: string; what_i_do: string | null }[] }>('handoff_recipients', {});
    expect(rec.recipients.find((x) => x.name === 'alphabot')!.what_i_do).toBe('Builds the Alpha app.');
    expect(rec.recipients.find((x) => x.name === 'betabot')!.what_i_do).toBeNull();
    const m = await w.client('alice').call<{ members: { name: string; what_i_do: string | null }[] }>('admin_space_members', { space: 'proj-alpha' });
    expect(m.members.find((x) => x.name === 'alphabot')!.what_i_do).toBe('Builds the Alpha app.');
  });

  it('Alpha ↛ Beta: visibility ends with the last shared membership; profiles and the To picker leak nothing after', async () => {
    await world();
    const canary = `zqalphaprofile${Date.now().toString(36)}`;
    await w.client('alphabot').call('profile_update', { what_i_do: `Builds ${canary}.`, contact: `ping ${canary}` });
    const betabot = w.client('betabot');
    // Shared: handoff (General) and shared. Leave one: still visible.
    expect((await betabot.call<ProfileOut>('profile_get', { name: 'alphabot' })).profile.what_i_do).toContain(canary);
    removeGrant(h.core, { spaceId: w.spaces.handoff.id, scope: 'space', subjectType: 'principal', subjectId: w.principals.alphabot.id });
    expect((await betabot.call<ProfileOut>('profile_get', { name: 'alphabot' })).profile.name).toBe('alphabot');
    // Leave the last one: gone, exactly like a name that does not exist.
    removeGrant(h.core, { spaceId: w.spaces.shared.id, scope: 'space', subjectType: 'principal', subjectId: w.principals.alphabot.id });
    await sameAsMissing(betabot, 'alphabot');
    // Both still read recipes through the computed all-agents group: ambient access is not a membership.
    expect((await betabot.call<{ spaces: { slug: string }[] }>('spaces', {})).spaces.map((s) => s.slug)).toContain('recipes');
    // Nothing of alphabot's profile reaches betabot anywhere.
    const texts: [string, RawResponse][] = [
      ['recipients', await betabot.raw('handoff_recipients', {})],
      ['profile_get self', await betabot.raw('profile_get', {})],
      ['start_here', await betabot.raw('start_here', {})],
      ['whoami', await betabot.raw('whoami', {})],
      ['spaces', await betabot.raw('spaces', {})],
      ['search', await betabot.raw('search', { query: canary })],
      ['mcp profile_get', await w.client('betabot', 'mcp').raw('profile_get', { name: 'alphabot' })],
      ['mcp start_here', await w.client('betabot', 'mcp').raw('start_here', {})],
    ];
    for (const [where, r] of texts) expect(r.text.includes(canary), where).toBe(false);
    expect((await betabot.call<{ recipients: { name: string }[] }>('handoff_recipients', {})).recipients.map((x) => x.name)).not.toContain('alphabot');
    // And the other way round.
    await w.client('betabot').call('profile_update', { what_i_do: 'Beta things.' });
    await sameAsMissing(w.client('alphabot'), 'betabot');
    // A disabled principal has no profile for anyone else.
    await w.client('alice').call('admin_principal_disable', { name: 'alice-helper' });
    await sameAsMissing(w.client('alice-assistant'), 'alice-helper');
  });

  it('a Guest sees the same minimal identity as in its To picker: no manager', async () => {
    await world();
    const alice = w.client('alice');
    await alice.call('admin_principal_create', { name: 'guesty', kind: 'agent', trust: 'trusted' });
    await alice.call('admin_grant_set', { space: 'handoff', scope: 'space', subject: { type: 'principal', name: 'guesty' }, role: 'guest' });
    const { token } = await alice.call<{ token: string }>('admin_token_issue', { principal: 'guesty', label: 'g' });
    const g = (await import('../helpers/clients/index.js')).makeClient('rest', h, token);
    const p = await g.call<ProfileOut>('profile_get', { name: 'alphabot' });
    expect(p.profile.manager).toBeNull();
    // A Guest fills in its own profile (start_here asks it to).
    expect((await g.call<ProfileOut>('profile_update', { what_i_do: 'Guest helper.' })).profile.what_i_do).toBe('Guest helper.');
  });
});

describe('legacy agent cards (deprecated documents)', () => {
  it('stay readable and writable; their fields are only suggestions for a human; conflicting cards are flagged', async () => {
    await world();
    const alphabot = w.client('alphabot');
    const card = '---\ntitle: Alphabot\n---\n# Alphabot\n\n## What I do\nBuilds and ships the Alpha mobile app.\n\n## How to reach\nhandoff_send to alphabot.\n\n## Response time\nWithin a working day.\n';
    const written = await alphabot.call<{ doc: { id: string; rev: number } }>('write', { space: 'handoff', path: '_agents/alphabot.md', content: card, expected_rev: 0, message: 'card' });
    const read = await w.client('betabot').call<{ content: string }>('read', { space: 'handoff', path: '_agents/alphabot.md' });
    expect(read.content).toBe(card);
    const edited = await alphabot.call<{ doc: { rev: number } }>('write', {
      space: 'handoff',
      path: '_agents/alphabot.md',
      content: card.replace('Within a working day.', 'Within an hour.'),
      expected_rev: written.doc.rev,
      message: 'faster',
    });
    expect(edited.doc.rev).toBe(2);
    const alice = w.client('alice');
    type Admin = { profile: Profile; cards: { space: string; path: string; rev: number; what_i_do: string | null; contact: string | null; response_times: string | null }[]; conflict: boolean };
    let a = await alice.call<Admin>('admin_profile_get', { name: 'alphabot' });
    expect(a.cards).toEqual([
      { space: 'handoff', path: '_agents/alphabot.md', doc_id: written.doc.id, rev: 2, what_i_do: 'Builds and ships the Alpha mobile app.', contact: 'handoff_send to alphabot.', response_times: 'Within an hour.' },
    ]);
    expect(a.conflict).toBe(false);
    // Never copied into the profile on its own.
    expect(a.profile.what_i_do).toBeNull();
    expect((await w.client('betabot').call<ProfileOut>('profile_get', { name: 'alphabot' })).profile.what_i_do).toBeNull();
    // A human accepts the suggestion.
    await alice.call('admin_principal_update', { name: 'alphabot', what_i_do: a.cards[0]!.what_i_do, contact: `${a.cards[0]!.contact} ${a.cards[0]!.response_times}` });
    expect((await w.client('betabot').call<ProfileOut>('profile_get', { name: 'alphabot' })).profile.what_i_do).toBe('Builds and ships the Alpha mobile app.');
    // A second card in another space with messages that says something else: conflict.
    await alice.call('admin_space_create', { slug: 'alpha-box', name: 'Alpha box', inbox: true });
    await alice.call('admin_grant_set', { space: 'alpha-box', scope: 'space', subject: { type: 'principal', name: 'alphabot' }, role: 'write' });
    await alphabot.call('write', { space: 'alpha-box', path: '_agents/alphabot.md', content: 'Tests the Alpha backend.\n', expected_rev: 0, message: 'card' });
    a = await alice.call<Admin>('admin_profile_get', { name: 'alphabot' });
    expect(a.cards.map((c) => [c.space, c.what_i_do])).toEqual([
      ['alpha-box', 'Tests the Alpha backend.'],
      ['handoff', 'Builds and ships the Alpha mobile app.'],
    ]);
    expect(a.conflict).toBe(true);
    // Deleting a card works as for any document; it leaves the profile alone.
    await alphabot.call('delete', { space: 'alpha-box', path: '_agents/alphabot.md' });
    a = await alice.call<Admin>('admin_profile_get', { name: 'alphabot' });
    expect(a.cards).toHaveLength(1);
    expect(a.profile.what_i_do).toBe('Builds and ships the Alpha mobile app.');
  });
});

describe('External: a label from the Manager, changed by a human only', () => {
  it('a human sets and clears it; an agent — even with the admin capability — is forbidden', async () => {
    await world();
    const alice = w.client('alice');
    await alice.call('admin_principal_update', { name: 'alice-assistant', admin: true });
    const agentAdmin = w.client('alice-assistant');
    // The agent administrator may not make someone external…
    const e1 = await err(agentAdmin.call('admin_principal_update', { name: 'betabot', external: true, owner_label: 'Erin' }));
    expect(e1.code).toBe('forbidden');
    // …the human may: the Manager becomes the outside person.
    type P = { principal: { external: { owner_label: string | null } | null; owner: string | null } };
    const on = await alice.call<P>('admin_principal_update', { name: 'betabot', external: true, owner_label: 'Erin' });
    expect(on.principal.external?.owner_label).toBe('Erin');
    expect((await w.client('alphabot').call<ProfileOut>('profile_get', { name: 'betabot' })).profile).toMatchObject({ external: true, manager: 'Erin' });
    // Changing an external agent at all needs a human.
    expect((await err(agentAdmin.call('admin_principal_update', { name: 'betabot', what_i_do: 'x' }))).code).toBe('forbidden');
    expect((await err(agentAdmin.call('admin_principal_update', { name: 'betabot', external: false }))).code).toBe('forbidden');
    // Back to a person in Brain.
    const off = await alice.call<P>('admin_principal_update', { name: 'betabot', external: false, owner: 'alice' });
    expect(off.principal.external).toBeNull();
    expect(off.principal.owner).toBe('alice');
  });
});
