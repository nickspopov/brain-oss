// The role ladder is a read model over the grant engine. Property test over seeded random
// grant/review combinations: every existing permission reads back identically (the ladder name is the
// engine's role, custom access exactly when folder/document grants contradict it, the review fields as
// stored) and reading changes nothing. Then: Custom access display, proposer kept, the Add member picker,
// "Only these N can see this space", who "Notify me" notifies, admin-only.
import { afterEach, describe, expect, it } from 'vitest';
import { setGrant } from '../../src/core/grants.js';
import { contextForRow, isMessageOnly, roleAt } from '../../src/core/guard.js';
import { LADDER_OF } from '../../src/core/members.js';
import { routeWrite } from '../../src/core/review.js';
import { updateSpaceSettings } from '../../src/core/spaces.js';
import { patchPrincipal } from '../../src/core/principals.js';
import { pathKey } from '../../src/core/paths.js';
import type { GrantRow, PrincipalRow, Role, SpaceRow } from '../../src/store/types.js';
import { buildWorld, SPACES, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

afterEach(async () => {
  await h?.close();
});

/** mulberry32: a small deterministic PRNG, so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

interface Member {
  name: string;
  disabled: boolean;
  access: { role: string; engine_role: Role; custom: boolean; messages_only: boolean; personal: Role | null; overrides: { id: string }[]; visible: boolean; member: boolean };
}
interface Members {
  space: { slug: string; review_mode: string; executable: boolean; protected_paths: string[]; inbox: boolean };
  members: Member[];
  can_see: number;
  candidates: { type: string; name: string; kind: string }[];
  notify: { people: string[]; webhooks: number };
}
interface Explain {
  spaces: { space: string; role: Role; member: Member['access'] }[];
}

const spaceRow = (slug: string): SpaceRow => h.core.db.prepare('SELECT * FROM spaces WHERE slug = ?').get(slug) as SpaceRow;
const principalRows = (): PrincipalRow[] => h.core.db.prepare("SELECT * FROM principals WHERE kind != 'system' ORDER BY name").all() as PrincipalRow[];
const grants = (): GrantRow[] => h.core.db.prepare('SELECT * FROM grants ORDER BY id').all() as GrantRow[];

/** Everything the engine decides, for every principal × space × sample target (and the write route). */
function engineSnapshot(docs: Map<string, { a: string; b: string }>): string {
  const out: unknown[] = [];
  for (const p of principalRows()) {
    const view = contextForRow(h.core, p);
    for (const slug of SPACES) {
      const s = spaceRow(slug);
      const d = docs.get(slug)!;
      const targets: [string | undefined, string | undefined][] = [
        [undefined, undefined],
        ['a/', undefined],
        [pathKey('a/one.md'), d.a],
        [pathKey('b/two.md'), d.b],
        [pathKey('c/x.md'), undefined],
      ];
      for (const [k, id] of targets) {
        const role = roleAt(view, s, k, id);
        out.push([p.name, slug, k ?? '', role, k && !k.endsWith('/') ? routeWrite(s, k, role, p.trust) : '']);
      }
    }
  }
  return JSON.stringify({ out, grants: grants(), spaces: h.core.db.prepare('SELECT * FROM spaces ORDER BY id').all() });
}

const ROLES: Role[] = ['none', 'read', 'propose', 'write', 'admin'];

describe('role ladder = the engine, over seeded random grant and review combinations', () => {
  it('every permission and review setting reads back identically; reading changes nothing', { timeout: 240_000 }, async () => {
    for (let seed = 1; seed <= 10; seed++) {
      h = await startHarness();
      w = buildWorld(h);
      const r = rng(seed * 7919);
      const alice = w.client('alice');
      // Documents to aim document grants at, in every space.
      const docs = new Map<string, { a: string; b: string }>();
      for (const slug of SPACES) {
        const a = await alice.call<{ doc: { id: string } }>('write', { space: slug, path: 'a/one.md', content: '# one\n', expected_rev: 0, message: 'seed' });
        const b = await alice.call<{ doc: { id: string } }>('write', { space: slug, path: 'b/two.md', content: '# two\n', expected_rev: 0, message: 'seed' });
        docs.set(slug, { a: a.doc.id, b: b.doc.id });
      }
      // Random review settings.
      for (const slug of SPACES) {
        updateSpaceSettings(h.core, spaceRow(slug), {
          reviewMode: pick(r, ['off', 'off', 'limited', 'all'] as const),
          executable: r() < 0.3,
          protectedPaths: r() < 0.3 ? ['a/one.md'] : [],
        });
      }
      // Random grants: personal and group, space / folder / document, every role (Guest where it is valid).
      const principals = principalRows();
      const groupIds = [w.groups.curators, (h.core.db.prepare("SELECT id FROM groups WHERE name = 'all-agents'").get() as { id: string }).id];
      for (let i = 0; i < 18; i++) {
        const slug = pick(r, SPACES);
        const s = spaceRow(slug);
        const scope = pick(r, ['space', 'space', 'path', 'doc'] as const);
        const group = r() < 0.25;
        const subjectId = group ? pick(r, groupIds) : pick(r, principals).id;
        let role = pick(r, ROLES);
        if (!group && scope === 'space' && s.inbox === 1 && r() < 0.2) role = 'guest';
        setGrant(
          h.core,
          {
            spaceId: s.id,
            scope,
            pathPrefix: scope === 'path' ? pick(r, ['a/', 'b/']) : null,
            docId: scope === 'doc' ? pick(r, [docs.get(slug)!.a, docs.get(slug)!.b]) : null,
            subjectType: group ? 'group' : 'principal',
            subjectId,
            role,
          },
          w.principals.alice.id,
        );
      }
      // Sometimes an external agent (the engine treats it as Guest where messages are on).
      if (r() < 0.5) patchPrincipal(h.core, w.principals.betabot.id, { external: 1, owner_label: 'Erin' });

      const before = engineSnapshot(docs);
      const members = new Map<string, Members>();
      for (const slug of SPACES) members.set(slug, await alice.call<Members>('admin_space_members', { space: slug }));
      const explains = new Map<string, Explain>();
      for (const p of principalRows()) explains.set(p.name, await alice.call<Explain>('admin_access_explain', { principal: p.name }));
      for (const p of principalRows()) await alice.call('admin_profile_get', { name: p.name });
      await alice.call('handoff_recipients', {});
      // Reading the read models changed nothing the engine decides.
      expect(engineSnapshot(docs), `seed ${seed}`).toBe(before);

      const all = grants();
      for (const slug of SPACES) {
        const s = spaceRow(slug);
        const m = members.get(slug)!;
        // Review settings read back exactly as stored.
        expect(m.space, `seed ${seed} ${slug}`).toMatchObject({
          review_mode: s.review_mode,
          executable: s.executable === 1,
          protected_paths: JSON.parse(s.protected_paths) as string[],
          inbox: s.inbox === 1,
        });
        for (const p of principalRows()) {
          const view = contextForRow(h.core, p);
          const messagesOnly = view.principal.role !== 'superadmin' && isMessageOnly(view, s);
          const engine: Role = messagesOnly ? 'guest' : roleAt(view, s);
          const row = m.members.find((x) => x.name === p.name);
          const ex = explains.get(p.name)!.spaces.find((x) => x.space === slug)!;
          const where = `seed ${seed}: ${p.name} in ${slug}`;
          // The ladder name is the engine's space-level role; explain says the same.
          expect(ex.member.engine_role, where).toBe(engine);
          expect(ex.member.role, where).toBe(LADDER_OF[engine]);
          if (!messagesOnly) expect(ex.role, where).toBe(engine);
          // Custom access exactly when a folder/document grant of it (or its groups) contradicts that role.
          // (all-agents gives nothing in proj-* spaces and spaces with messages: not in effect there.)
          const ambientOff = s.inbox === 1 || s.slug.startsWith('proj-');
          const applicable = all.filter(
            (g) =>
              g.space_id === s.id &&
              g.scope !== 'space' &&
              !(ambientOff && g.subject_type === 'group' && g.subject_id === groupIds[1]) &&
              (g.subject_type === 'principal' ? g.subject_id === p.id : view.groupIds.includes(g.subject_id)),
          );
          const custom = p.role !== 'superadmin' && !messagesOnly && p.disabled_at === null && applicable.some((g) => g.role !== engine);
          expect(ex.member.custom, where).toBe(custom);
          // A proposer stays a proposer (never shown as Editor).
          if (engine === 'propose') expect(ex.member.role, where).toBe('proposer');
          // Listed in Members iff it is a member; then the same access as in explain.
          if (ex.member.member) {
            expect(row, where).toBeDefined();
            expect(row!.access, where).toEqual(ex.member);
          } else expect(row?.access.member ?? false, where).toBe(false);
        }
      }
      await h.close();
    }
  });
});

describe('Members read model', () => {
  it('Custom access: a folder deny or a wider folder grant contradicts the simple label; overrides are listed', async () => {
    h = await startHarness();
    w = buildWorld(h);
    w.grant('proj-alpha', { principal: 'alphabot' }, 'write', { path: 'secret/' });
    const alice = w.client('alice');
    let m = await alice.call<Members>('admin_space_members', { space: 'proj-alpha' });
    // Same role on the folder as on the space: not custom.
    expect(m.members.find((x) => x.name === 'alphabot')!.access).toMatchObject({ role: 'editor', custom: false });
    w.grant('proj-alpha', { principal: 'alphabot' }, 'none', { path: 'secret/' });
    m = await alice.call<Members>('admin_space_members', { space: 'proj-alpha' });
    const f = m.members.find((x) => x.name === 'alphabot')!;
    expect(f.access).toMatchObject({ role: 'editor', engine_role: 'write', custom: true, personal: 'write' });
    expect(f.access.overrides).toHaveLength(1);
    // Viewer of shared with Editor on one folder: custom.
    w.grant('shared', { principal: 'betabot' }, 'write', { path: 'drafts/' });
    m = await alice.call<Members>('admin_space_members', { space: 'shared' });
    expect(m.members.find((x) => x.name === 'betabot')!.access).toMatchObject({ role: 'viewer', custom: true });
    // Only a folder grant (no space role): a member with custom access, role none on the space.
    w.grant('proj-beta', { principal: 'alice-helper' }, 'read', { path: 'pub/' });
    m = await alice.call<Members>('admin_space_members', { space: 'proj-beta' });
    expect(m.members.find((x) => x.name === 'alice-helper')!.access).toMatchObject({ role: 'none', custom: true, visible: true, member: true });
  });

  it('a proposer stays Proposer; Guest is Guest; the superadmin is Admin everywhere', async () => {
    h = await startHarness();
    w = buildWorld(h);
    w.grant('shared', { principal: 'betabot' }, 'propose');
    const alice = w.client('alice');
    await alice.call('admin_principal_create', { name: 'guesty', kind: 'agent', trust: 'trusted' });
    await alice.call('admin_grant_set', { space: 'handoff', scope: 'space', subject: { type: 'principal', name: 'guesty' }, role: 'guest' });
    const shared = await alice.call<Members>('admin_space_members', { space: 'shared' });
    expect(shared.members.find((x) => x.name === 'betabot')!.access).toMatchObject({ role: 'proposer', engine_role: 'propose' });
    expect(shared.members.find((x) => x.name === 'alice')!.access).toMatchObject({ role: 'admin', superadmin: true });
    const general = await alice.call<Members>('admin_space_members', { space: 'handoff' });
    expect(general.members.find((x) => x.name === 'guesty')!.access).toMatchObject({ role: 'guest', messages_only: true, visible: false });
  });

  it('Add member picker: active only; all-agents never offered for proj-* (or spaces with messages); offered elsewhere', async () => {
    h = await startHarness();
    w = buildWorld(h);
    const alice = w.client('alice');
    await alice.call('admin_principal_create', { name: 'old-bot', kind: 'agent', trust: 'trusted' });
    await alice.call('admin_principal_disable', { name: 'old-bot' });
    await alice.call('admin_principal_create', { name: 'dave', kind: 'human', trust: 'trusted' });
    const alpha = await alice.call<Members>('admin_space_members', { space: 'proj-alpha' });
    const names = alpha.candidates.map((c) => `${c.type}:${c.name}`);
    expect(names).not.toContain('group:all-agents');
    expect(names).not.toContain('principal:old-bot');
    expect(names).not.toContain('principal:alphabot'); // already a member
    expect(names).toEqual(expect.arrayContaining(['principal:dave', 'principal:betabot', 'group:curators']));
    const general = await alice.call<Members>('admin_space_members', { space: 'handoff' });
    expect(general.candidates.map((c) => c.name)).not.toContain('all-agents');
    const shared = await alice.call<Members>('admin_space_members', { space: 'shared' });
    expect(shared.candidates.map((c) => c.name)).toContain('all-agents');
  });

  it('"Only these N can see this space": active members who see it or use its messages', async () => {
    h = await startHarness();
    w = buildWorld(h);
    const alice = w.client('alice');
    let alpha = await alice.call<Members>('admin_space_members', { space: 'proj-alpha' });
    expect(alpha.members.filter((m) => m.access.member).map((m) => m.name).sort()).toEqual(['alice', 'alphabot']);
    expect(alpha.can_see).toBe(2);
    await alice.call('admin_principal_disable', { name: 'alphabot' });
    alpha = await alice.call<Members>('admin_space_members', { space: 'proj-alpha' });
    expect(alpha.can_see).toBe(1);
    // A disabled member keeps its grant and is listed (flagged) so it can be removed.
    expect(alpha.members.find((m) => m.name === 'alphabot')).toMatchObject({ disabled: true });
  });

  it('"Notify me": the people who are Admins of the space, and webhooks on flagged edits', async () => {
    h = await startHarness();
    w = buildWorld(h);
    const alice = w.client('alice');
    await alice.call('admin_principal_create', { name: 'bob', kind: 'human', trust: 'trusted', display_name: 'Bob' });
    await alice.call('admin_grant_set', { space: 'recipes', scope: 'space', subject: { type: 'principal', name: 'bob' }, role: 'admin' });
    let m = await alice.call<Members>('admin_space_members', { space: 'recipes' });
    // curators (alice-assistant, an agent) are Admins too, but agents are not notified people.
    expect(m.notify.people.sort()).toEqual(['Alice', 'Bob']);
    expect(m.notify.webhooks).toBe(0);
    await alice.call('admin_webhook_create', { url: 'https://hooks.example/x', space: 'recipes', attention_only: true });
    m = await alice.call<Members>('admin_space_members', { space: 'recipes' });
    expect(m.notify.webhooks).toBe(1);
    // A read: audited without detail (a large result must not overflow the audit row).
    const rows = h.core.db.prepare("SELECT outcome, detail FROM audit WHERE op = 'admin_space_members'").all() as { outcome: string; detail: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual({ outcome: 'ok', detail: null });
  });

  it('admin only: without the admin capability the read models are indistinguishable from a missing operation', async () => {
    h = await startHarness();
    w = buildWorld(h);
    const alphabot = w.client('alphabot');
    const missing = await alphabot.raw('no_such_operation', {});
    for (const op of ['admin_space_members', 'admin_profile_get']) {
      const r = await alphabot.raw(op, {});
      expect({ status: r.status, text: r.text }).toEqual({ status: missing.status, text: missing.text });
    }
  });
});
