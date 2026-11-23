// In-process snapshot of permissions, keyed by the aclVersion counter. Single process, no races.
// Tokens and sessions are not part of it: they are checked against the DB on every request.
import { getGroupByName, listMemberships } from '../../store/groups.js';
import { listGrantsOfTenant } from '../../store/grants.js';
import { listSpaceAliases, listSpaces } from '../../store/spaces.js';
import type { GrantRow, SpaceRow } from '../../store/types.js';
import { ALL_AGENTS_GROUP } from '../bootstrap.js';
import type { Core } from '../context.js';

export interface AclSnapshot {
  version: number;
  spaces: readonly SpaceRow[];
  /** By id; an alias id (old revisions, exports) gives the canonical space. */
  spaceById: ReadonlyMap<string, SpaceRow>;
  /** By slug; an alias slug (old MCP `space` values, old paths) gives the canonical space. */
  spaceBySlug: ReadonlyMap<string, SpaceRow>;
  /**
   * Effective grants by space. Grants to the computed group all-agents are left out
   * in inbox spaces and proj-* spaces (no ambient access there; see `noAmbientGrants`).
   */
  grantsBySpace: ReadonlyMap<string, readonly GrantRow[]>;
  /** Explicit groups of each principal. */
  groupsOf: ReadonlyMap<string, readonly string[]>;
  allAgentsGroupId: string | null;
}

/**
 * Spaces where the computed group all-agents gives nothing: inbox
 * spaces and proj-* spaces. Access there is explicit only.
 */
export function noAmbientGrants(space: Pick<SpaceRow, 'inbox' | 'slug'>): boolean {
  return space.inbox === 1 || space.slug.startsWith('proj-');
}

const cache = new WeakMap<Core, AclSnapshot>();

/** Every write that affects permissions calls this (in the same transaction or right after). */
export function bumpAcl(core: Core): void {
  core.acl.version++;
}

export function aclSnapshot(core: Core): AclSnapshot {
  const cached = cache.get(core);
  if (cached && cached.version === core.acl.version) return cached;
  const version = core.acl.version;
  const spaces = listSpaces(core.db, core.tenantId);
  const allAgentsGroupId = getGroupByName(core.db, core.tenantId, ALL_AGENTS_GROUP)?.id ?? null;
  const closed = new Set(spaces.filter(noAmbientGrants).map((s) => s.id));
  const grantsBySpace = new Map<string, GrantRow[]>();
  for (const g of listGrantsOfTenant(core.db, core.tenantId)) {
    if (g.subject_type === 'group' && g.subject_id === allAgentsGroupId && closed.has(g.space_id)) continue;
    const list = grantsBySpace.get(g.space_id);
    if (list) list.push(g);
    else grantsBySpace.set(g.space_id, [g]);
  }
  const groupsOf = new Map<string, string[]>();
  for (const m of listMemberships(core.db, core.tenantId)) {
    const list = groupsOf.get(m.principal_id);
    if (list) list.push(m.group_id);
    else groupsOf.set(m.principal_id, [m.group_id]);
  }
  const spaceById = new Map(spaces.map((s) => [s.id, s]));
  const spaceBySlug = new Map(spaces.map((s) => [s.slug, s]));
  // Aliases: never listed, never hold grants in effect; old slug/id → canonical.
  for (const a of listSpaceAliases(core.db, core.tenantId)) {
    const target = a.alias_of ? spaceById.get(a.alias_of) : undefined;
    if (!target) continue;
    spaceById.set(a.id, target);
    if (!spaceBySlug.has(a.slug)) spaceBySlug.set(a.slug, target);
  }
  const snap: AclSnapshot = {
    version,
    spaces,
    spaceById,
    spaceBySlug,
    grantsBySpace,
    groupsOf,
    allAgentsGroupId,
  };
  cache.set(core, snap);
  return snap;
}
