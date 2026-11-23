// Members and the role ladder: a read model over the grant
// engine. Guest · Viewer · Editor · Admin (Proposer for an existing propose role) is how the space-level
// role the engine resolves is *named*; folder/document grants and denies stay what they are and are listed
// as overrides. Nothing here decides access: every role comes from `explainRole` (core/guard), so the
// labels cannot drift from what the engine enforces. Read-only — no grant is created or changed.
import type { GrantRow, PrincipalRow, Role, SpaceRow } from '../store/types.js';
import { atLeast } from './access/resolve.js';
import { noAmbientGrants } from './access/snapshot.js';
import { ALL_AGENTS_GROUP } from './bootstrap.js';
import type { Core } from './context.js';
import { notFound } from './errors.js';
import { type AccessContext, contextForRow, explainRole, isMessageOnly, isSuperadmin, visibleSpaces } from './guard.js';
import { allGroups } from './groups.js';
import { allPrincipals, findPrincipal } from './principals.js';
import { findSpace } from './spaces.js';

export type Ladder = 'none' | 'guest' | 'viewer' | 'proposer' | 'editor' | 'admin';

/** Engine role → its name on the ladder (Guest → guest, Viewer → read, Editor → write, Admin → admin). */
export const LADDER_OF: Readonly<Record<Role, Ladder>> = { none: 'none', guest: 'guest', read: 'viewer', propose: 'proposer', write: 'editor', admin: 'admin' };

export interface MemberAccess {
  /** The ladder name of the space-level role the engine resolves (Guest for a message-only member). */
  role: Ladder;
  /** That role as the engine stores it. */
  engine_role: Role;
  /** Messages only: a Guest, or an external agent in a space with messages (the engine treats it as Guest). */
  messages_only: boolean;
  /** An external agent treated as Guest without a guest grant (its other grants there are not in effect). */
  external_as_guest: boolean;
  /** The instance superadmin: admin everywhere. */
  superadmin: boolean;
  /** Its personal space-level grant, if any. */
  personal: Role | null;
  /** Space-level grants through groups (all-agents included where it applies). */
  groups: { name: string; role: Role }[];
  /** Folder and document grants (and denies) that apply to it and are in effect. */
  overrides: GrantRow[];
  /** Overrides contradict the simple label: the UI shows "Custom access". */
  custom: boolean;
  /** The space appears in its spaces (documents); a Guest uses only its messages. */
  visible: boolean;
  /** Is it a member at all: a role ≥ guest on the space, or custom access that opens something. */
  member: boolean;
}

/**
 * Ladder access of the principal behind `view` in `space`. The same resolver as every request, so
 * "every existing permission reads back identically" holds by construction (and is tested over seeds).
 */
export function memberAccess(view: AccessContext, space: SpaceRow, visibleIds?: ReadonlySet<string>): MemberAccess {
  const snap = view.snapshot;
  const groupNames = new Map(allGroups(view.core).map((g) => [g.id, g.name]));
  const mine = (snap.grantsBySpace.get(space.id) ?? []).filter((g) =>
    g.subject_type === 'principal' ? g.subject_id === view.principal.id : view.groupIds.includes(g.subject_id),
  );
  const superadmin = isSuperadmin(view);
  const messagesOnly = !superadmin && isMessageOnly(view, space);
  const r = explainRole(view, space);
  const engine: Role = messagesOnly ? 'guest' : r.role;
  const personal = mine.find((g) => g.scope === 'space' && g.subject_type === 'principal')?.role ?? null;
  const groups = mine
    .filter((g) => g.scope === 'space' && g.subject_type === 'group')
    .map((g) => ({ name: groupNames.get(g.subject_id) ?? ALL_AGENTS_GROUP, role: g.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Overrides are in effect unless the member is the superadmin (admin everywhere) or message-only (a
  // Guest's other grants in that space are not in effect).
  const overrides = superadmin || messagesOnly || view.disabled ? [] : mine.filter((g) => g.scope !== 'space');
  const custom = overrides.some((g) => g.role !== engine);
  const visible = !messagesOnly && (visibleIds ? visibleIds.has(space.id) : visibleSpaces(view).some((v) => v.space.id === space.id));
  return {
    role: LADDER_OF[engine],
    engine_role: engine,
    messages_only: messagesOnly,
    external_as_guest: messagesOnly && view.principal.external === true && personal !== 'guest',
    superadmin,
    personal,
    groups,
    overrides,
    custom,
    visible,
    member: !view.disabled && (atLeast(engine, 'guest') || visible),
  };
}

export interface SpaceMember {
  principal: PrincipalRow;
  access: MemberAccess;
}

export interface Candidate {
  type: 'principal' | 'group';
  name: string;
  display_name: string;
  kind: 'human' | 'agent' | 'group';
  external: boolean;
}

export interface SpaceMembers {
  space: SpaceRow;
  members: SpaceMember[];
  /** Active members who can see the space (documents) or use its messages. */
  can_see: number;
  /** "Add member" picker: active people and agents who are not members, and groups (never all-agents where it gives nothing). */
  candidates: Candidate[];
  /** "Notify me": who sees flagged edits — the space's Admins who are people — and webhooks on flagged edits. */
  notify: { people: string[]; webhooks: number };
}

function spaceOrNotFound(ctx: AccessContext, slug: string): SpaceRow {
  const s = findSpace(ctx.core, slug);
  if (!s) throw notFound();
  return s;
}

/** Members of a space with their ladder role; for its Members tab and Settings (Brain administrators). */
export function spaceMembers(ctx: AccessContext, slug: string): SpaceMembers {
  const space = spaceOrNotFound(ctx, slug);
  const members: SpaceMember[] = [];
  const outside: PrincipalRow[] = [];
  for (const p of allPrincipals(ctx.core)) {
    const view = contextForRow(ctx.core, p);
    const access = memberAccess(view, space);
    // Disabled members keep their grants: listed (flagged) so they can be removed.
    const listed = access.member || (p.disabled_at !== null && (access.personal !== null || access.groups.length > 0));
    if (listed) members.push({ principal: p, access });
    else if (p.disabled_at === null) outside.push(p);
  }
  members.sort((a, b) => rankOf(b.access.role) - rankOf(a.access.role) || a.principal.name.localeCompare(b.principal.name));
  const groups = allGroups(ctx.core).filter((g) => !(g.system === 1 && g.name === ALL_AGENTS_GROUP && noAmbientGrants(space)));
  const candidates: Candidate[] = [
    ...outside.map((p) => ({ type: 'principal' as const, name: p.name, display_name: p.display_name, kind: p.kind === 'human' ? ('human' as const) : ('agent' as const), external: p.external === 1 })),
    ...groups.map((g) => ({ type: 'group' as const, name: g.name, display_name: g.name, kind: 'group' as const, external: false })),
  ];
  const webhooks = (
    ctx.core.db
      .prepare("SELECT count(*) AS n FROM webhooks WHERE enabled = 1 AND (space_id IS NULL OR space_id = ?) AND attention_only = 1")
      .get(space.id) as { n: number }
  ).n;
  return {
    space,
    members,
    can_see: members.filter((m) => m.principal.disabled_at === null && (m.access.visible || m.access.messages_only)).length,
    candidates,
    notify: {
      people: members
        .filter((m) => m.principal.kind === 'human' && m.principal.disabled_at === null && m.access.engine_role === 'admin')
        .map((m) => m.principal.display_name || m.principal.name),
      webhooks,
    },
  };
}

const ORDER: readonly Ladder[] = ['none', 'guest', 'viewer', 'proposer', 'editor', 'admin'];
const rankOf = (l: Ladder): number => ORDER.indexOf(l);

/** Ladder access of a named principal in every space (its Access tab). */
export function principalAccess(core: Core, name: string): { principal: PrincipalRow; spaces: { space: SpaceRow; access: MemberAccess }[] } {
  const row = findPrincipal(core, name);
  if (!row) throw notFound();
  const view = contextForRow(core, row);
  const visible = new Set(visibleSpaces(view).map((v) => v.space.id));
  return { principal: row, spaces: view.snapshot.spaces.map((space) => ({ space, access: memberAccess(view, space, visible) })) };
}
