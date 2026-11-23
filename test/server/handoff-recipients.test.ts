// handoff_recipients — the To picker lists exactly whom handoff_send accepts. alphabot works in
// the project inbox alpha-handoff with friend-bot (external) and alice; betabot is in another project
// (handoff) and must never be offered to alphabot, nor alphabot to betabot.
import { afterEach, describe, expect, it } from 'vitest';
import { removeGrant, setGrant } from '../../src/core/grants.js';
import type { SpaceRow } from '../../src/store/types.js';
import { makeClient, type Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

interface R {
  name: string;
  display_name: string;
  external: boolean;
  manager: string | null;
  owner_label: string | null;
  spaces: string[];
}
const recipients = async (c: Client): Promise<R[]> => (await c.call<{ recipients: R[] }>('handoff_recipients', {})).recipients;

async function setup(): Promise<{ alice: Client; alphabot: Client; betabot: Client }> {
  h = await startHarness();
  w = buildWorld(h, 'rest');
  const core = h.core;
  removeGrant(core, { spaceId: w.spaces.handoff.id, scope: 'space', subjectType: 'principal', subjectId: w.principals.alphabot.id });
  removeGrant(core, { spaceId: w.spaces.shared.id, scope: 'space', subjectType: 'principal', subjectId: w.principals.betabot.id });
  const alice = makeClient('rest', h, w.tokens.alice);
  await alice.call('admin_space_create', { slug: 'alpha-handoff', name: 'Alpha inbox', inbox: true });
  const box = core.db.prepare('SELECT * FROM spaces WHERE slug = ?').get('alpha-handoff') as SpaceRow;
  setGrant(core, { spaceId: box.id, scope: 'space', pathPrefix: null, docId: null, role: 'write', subjectType: 'principal', subjectId: w.principals.alphabot.id }, w.principals.alice.id);
  await alice.call('admin_principal_create', { name: 'friend-bot', kind: 'agent', trust: 'limited', external: true, owner_label: 'Erin' });
  await alice.call('admin_grant_set', { space: 'alpha-handoff', scope: 'space', subject: { type: 'principal', name: 'friend-bot' }, role: 'write' });
  return { alice, alphabot: w.client('alphabot'), betabot: w.client('betabot') };
}

afterEach(async () => {
  await h?.close();
});

describe('handoff_recipients', () => {
  it('lists only recipients of the caller’s own inbox spaces, never itself, never another project’s agents', async () => {
    const s = await setup();
    const forAlphabot = await recipients(s.alphabot);
    const names = forAlphabot.map((r) => r.name);
    expect(names).toContain('friend-bot');
    expect(names).toContain('alice');
    expect(names).not.toContain('betabot');
    expect(names).not.toContain('alphabot');
    expect(forAlphabot.every((r) => r.spaces.every((sp) => sp === 'alpha-handoff'))).toBe(true);
    const friend = forAlphabot.find((r) => r.name === 'friend-bot')!;
    expect(friend.external).toBe(true);
    expect(friend.owner_label).toBe('Erin');
    expect((await recipients(s.betabot)).map((r) => r.name)).not.toContain('alphabot');
    expect((await recipients(s.betabot)).map((r) => r.name)).not.toContain('friend-bot');
  });

  it('every listed recipient is accepted by handoff_send in every listed space', async () => {
    const s = await setup();
    for (const who of [s.alice, s.alphabot, s.betabot]) {
      for (const r of await recipients(who)) {
        for (const space of r.spaces) {
          const out = await who.call<{ message: { to: string; space: string } }>('handoff_send', { to: r.name, title: `To ${r.name}`, body: 'b', space });
          expect(out.message).toMatchObject({ to: r.name, space });
        }
      }
    }
  });

  it('a disabled principal is not offered; the manager is named', async () => {
    const s = await setup();
    await s.alice.call('admin_principal_update', { name: 'betabot', owner: 'alice' });
    const before = (await recipients(s.alice)).find((r) => r.name === 'betabot');
    expect(before?.manager).toBe('alice');
    await s.alice.call('admin_principal_disable', { name: 'betabot' });
    expect((await recipients(s.alice)).map((r) => r.name)).not.toContain('betabot');
  });
});

describe('spaces[].archived', () => {
  it('marks an archived space for the superadmin, who still sees it; others do not see it at all', async () => {
    const s = await setup();
    await s.alice.call('admin_space_archive', { slug: 'alpha-handoff' });
    type Sp = { slug: string; archived?: true };
    const mine = (await s.alice.call<{ spaces: Sp[] }>('spaces', {})).spaces;
    expect(mine.find((x) => x.slug === 'alpha-handoff')?.archived).toBe(true);
    expect(mine.find((x) => x.slug === 'shared')).not.toHaveProperty('archived');
    expect((await s.alphabot.call<{ spaces: Sp[] }>('spaces', {})).spaces.map((x) => x.slug)).not.toContain('alpha-handoff');
    // An archived inbox space offers nobody (recipients come only from active inbox spaces).
    expect((await recipients(s.alphabot)).length).toBe(0);
    expect((await recipients(s.alice)).every((r) => !r.spaces.includes('alpha-handoff'))).toBe(true);
  });
});
