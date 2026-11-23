// Administrative actions by name, as the API sees them.
// Access to the operations is given by capability `admin` (execute checks it via `requires`). Here are the
// rules that protect the superadmin from an admin agent: only the superadmin may change the superadmin,
// its tokens, or grant capability `admin`.
import { getLiveDocViewByPathKey } from '../store/documents.js';
import { isInboxSpace } from './handoff.js';
import { getTokenById, listTokens } from '../store/tokens.js';
import type { GrantRow, GroupRow, PrincipalRow, Role, SpaceRow, TokenRow, Trust } from '../store/types.js';
import type { Resolution } from './access/resolve.js';
import { allGrants, removeGrant, setGrant, type GrantTarget } from './grants.js';
import { allGroups, createGroup, deleteGroup, findGroup, membersByGroup, renameGroup, setGroupMembers } from './groups.js';
import {
  type AccessContext,
  contextForRow,
  docInSpace,
  explainRole,
  isSuperadmin,
  visibleSpaces,
} from './guard.js';
import { conflict, forbidden, invalidInput, notFound, OpError } from './errors.js';
import type { Db } from '../db/open.js';
import { noAmbientGrants } from './access/snapshot.js';
import { limitsOf, mergeLimits, utcDayStart, type ExternalLimits } from './external.js';
import { allPrincipals, checkPassword, createPrincipal, findPrincipal, patchPrincipal, setDisabled } from './principals.js';
import { hashPassword } from './password.js';
import { pathKey, normalizePath, folderPrefixKey } from './paths.js';
import { allSpaces, createSpace, findSpace, parseProtectedPaths, setArchived, updateSpaceSettings, type SpaceSettings } from './spaces.js';
import { issueToken, revokeToken, type IssuedToken } from './tokens.js';
import { ALL_AGENTS_GROUP } from './bootstrap.js';
import { lastSeen } from './inbox.js';
import { memberAccess, type MemberAccess } from './members.js';
import { profileFields } from './profiles.js';

// ---------------------------------------------------------------- views

export interface PrincipalView {
  id: string;
  name: string;
  display_name: string;
  kind: PrincipalRow['kind'];
  role: PrincipalRow['role'];
  trust: Trust;
  admin: boolean;
  owner: string | null;
  harness: string | null;
  disabled_at: number | null;
  created_at: number;
  /** External principal: owner label, effective limits, messages sent today (UTC). */
  external: { owner_label: string | null; limits: ExternalLimits; sent_today: number } | null;
  /** Profile fields and the last time it used Brain. */
  what_i_do: string | null;
  contact: string | null;
  last_seen: number | null;
}

export interface TokenView {
  id: string;
  principal: string;
  prefix: string;
  label: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
}

export interface GroupView {
  id: string;
  name: string;
  description: string;
  system: boolean;
  /** For all-agents: the computed membership (enabled agents). */
  members: string[];
}

export interface GrantView {
  id: string;
  space: string;
  scope: GrantRow['scope'];
  path_prefix: string | null;
  doc_id: string | null;
  subject: { type: GrantRow['subject_type']; name: string };
  role: Role;
  granted_by: string | null;
  granted_at: number;
}

export interface SpaceView extends Omit<SpaceRow, 'protected_paths' | 'executable' | 'inbox'> {
  executable: boolean;
  inbox: boolean;
  protected_paths: string[];
}

function nameIndex(ctx: AccessContext): Map<string, string> {
  return new Map(allPrincipals(ctx.core).map((p) => [p.id, p.name]));
}

function sentToday(db: Db, principalId: string, now: number): number {
  return (db.prepare('SELECT count(*) AS n FROM handoff_messages WHERE sender_id = ? AND created_at >= ?').get(principalId, utcDayStart(now)) as { n: number }).n;
}

function principalView(p: PrincipalRow, names: Map<string, string>, db?: Db, now?: number): PrincipalView {
  return {
    id: p.id,
    name: p.name,
    display_name: p.display_name,
    kind: p.kind,
    role: p.role,
    trust: p.trust,
    admin: p.can_admin === 1 || p.role === 'superadmin',
    owner: p.owner_id ? (names.get(p.owner_id) ?? null) : null,
    harness: p.harness,
    disabled_at: p.disabled_at,
    created_at: p.created_at,
    external:
      p.external === 1
        ? { owner_label: p.owner_label, limits: limitsOf(p), sent_today: db !== undefined && now !== undefined ? sentToday(db, p.id, now) : 0 }
        : null,
    what_i_do: p.what_i_do ?? null,
    contact: p.contact_notes ?? null,
    last_seen: db !== undefined ? lastSeen(db, p.id) : null,
  };
}

/**
 * External principals are created, changed, granted and given tokens only by a human:
 * an agent — the admin agent included — cannot bring another person's agent in.
 */
function requireHumanFor(ctx: AccessContext, what: string): void {
  if (ctx.principal.kind !== 'human') throw new OpError('forbidden', { required: 'human', reason: 'external_principal' }, `Only a human can ${what} an external agent.`);
}

function tokenView(t: TokenRow, names: Map<string, string>): TokenView {
  return {
    id: t.id,
    principal: names.get(t.principal_id) ?? '',
    prefix: t.prefix,
    label: t.label,
    created_at: t.created_at,
    expires_at: t.expires_at,
    revoked_at: t.revoked_at,
    last_used_at: t.last_used_at,
    last_used_ip: t.last_used_ip,
  };
}

export function spaceView(s: SpaceRow): SpaceView {
  return { ...s, executable: s.executable === 1, inbox: s.inbox === 1, protected_paths: parseProtectedPaths(s) };
}

// ---------------------------------------------------------------- lookups

function principalByName(ctx: AccessContext, name: string): PrincipalRow {
  const p = findPrincipal(ctx.core, name);
  if (!p) throw notFound();
  return p;
}

/** Only the superadmin may change the superadmin (and its tokens). */
function guardTarget(ctx: AccessContext, target: PrincipalRow): void {
  if (target.role === 'superadmin' && !isSuperadmin(ctx)) throw forbidden('superadmin');
}

function requireSuperadminFor(ctx: AccessContext): void {
  if (!isSuperadmin(ctx)) throw forbidden('superadmin');
}

function spaceBySlug(ctx: AccessContext, slug: string): SpaceRow {
  const s = findSpace(ctx.core, slug);
  if (!s) throw notFound();
  return s;
}

function groupByName(ctx: AccessContext, name: string): GroupRow {
  const g = findGroup(ctx.core, name);
  if (!g) throw notFound();
  return g;
}

// ---------------------------------------------------------------- spaces

/**
 * Creates a space and grants its creator `admin` on it: a normal space-scope grant,
 * visible in admin_grant_list, in the same transaction.
 */
export function adminSpaceCreate(ctx: AccessContext, slug: string, settings: SpaceSettings): { space: SpaceView; grant: GrantView } {
  return ctx.core.db
    .transaction(() => {
      const space = createSpace(ctx.core, { slug, ...settings }, ctx.principal.id);
      const row = setGrant(
        ctx.core,
        { spaceId: space.id, scope: 'space', subjectType: 'principal', subjectId: ctx.principal.id, role: 'admin' },
        ctx.principal.id,
      );
      return { space: spaceView(space), grant: grantViews(ctx, [row])[0]! };
    })
    .immediate();
}

export function adminSpaceUpdate(ctx: AccessContext, slug: string, patch: SpaceSettings & { slug?: string }): SpaceView {
  return spaceView(updateSpaceSettings(ctx.core, spaceBySlug(ctx, slug), patch));
}

export function adminSpaceArchive(ctx: AccessContext, slug: string, archived: boolean): SpaceView {
  return spaceView(setArchived(ctx.core, spaceBySlug(ctx, slug), archived, ctx.principal.id));
}

export function adminSpaceList(ctx: AccessContext, includeArchived: boolean): SpaceView[] {
  return allSpaces(ctx.core)
    .filter((s) => includeArchived || s.archived_at === null)
    .map(spaceView);
}

// ---------------------------------------------------------------- principals

export interface PrincipalCreate {
  name: string;
  kind: 'human' | 'agent';
  display_name?: string | undefined;
  trust: Trust;
  owner?: string | undefined;
  harness?: string | undefined;
  password?: string | undefined;
  admin?: boolean | undefined;
  external?: boolean | undefined;
  owner_label?: string | undefined;
  limits?: LimitsPatch | undefined;
}

export type LimitsPatch = Partial<Record<keyof ExternalLimits, number | null>>;

export function adminPrincipalCreate(ctx: AccessContext, input: PrincipalCreate): PrincipalView {
  // A human is the one who can accept a proposal with human_required; only the superadmin may create one
  // (and give it a password or token), otherwise an admin agent could make itself a "human".
  if (input.admin || input.kind === 'human') requireSuperadminFor(ctx);
  if (input.external || input.owner_label !== undefined || input.limits !== undefined) {
    requireHumanFor(ctx, 'create');
    if (!input.external) throw invalidInput('external', 'owner_label and limits are for external agents (external: true).');
  }
  const owner = input.owner !== undefined ? principalByName(ctx, input.owner) : undefined;
  const row = createPrincipal(
    ctx.core,
    {
      name: input.name,
      kind: input.kind,
      trust: input.trust,
      ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
      ownerId: owner?.id ?? null,
      harness: input.harness ?? null,
      ...(input.password !== undefined ? { password: input.password } : {}),
      admin: input.admin ?? false,
      external: input.external ?? false,
      ownerLabel: input.owner_label ?? null,
      limits: input.external && input.limits !== undefined ? mergeLimits({ limits: null }, input.limits) : null,
    },
    ctx.principal.id,
  );
  return principalView(row, nameIndex(ctx), ctx.core.db, ctx.core.now());
}

export interface PrincipalUpdate {
  display_name?: string | undefined;
  trust?: Trust | undefined;
  owner?: string | null | undefined;
  harness?: string | null | undefined;
  admin?: boolean | undefined;
  password?: string | undefined;
  external?: boolean | undefined;
  owner_label?: string | null | undefined;
  limits?: LimitsPatch | undefined;
  /** Profile fields (also editable by the principal itself with profile_update). */
  what_i_do?: string | null | undefined;
  contact?: string | null | undefined;
}

export function adminPrincipalUpdate(ctx: AccessContext, name: string, patch: PrincipalUpdate): PrincipalView {
  const p = principalByName(ctx, name);
  guardTarget(ctx, p);
  if (patch.admin !== undefined) requireSuperadminFor(ctx);
  const touchesExternal = patch.external !== undefined || patch.owner_label !== undefined || patch.limits !== undefined;
  if (p.external === 1 || patch.external === true || touchesExternal) requireHumanFor(ctx, 'change');
  const external = patch.external ?? p.external === 1;
  if (external && p.kind !== 'agent') throw invalidInput('external', 'Only an agent can be external.');
  if (external && (patch.admin === true || (patch.admin === undefined && p.can_admin === 1))) {
    throw invalidInput('admin', 'An external agent cannot have the admin capability.');
  }
  if (!external && patch.limits !== undefined) throw invalidInput('limits', 'Limits are for external agents.');
  if (patch.password !== undefined) {
    requireSuperadminFor(ctx);
    if (p.kind !== 'human') throw invalidInput('password', 'Only a human has a password.');
    checkPassword(patch.password);
  }
  let ownerId: string | null | undefined;
  if (patch.owner === null) ownerId = null;
  else if (patch.owner !== undefined) {
    const owner = principalByName(ctx, patch.owner);
    if (owner.id === p.id) throw invalidInput('owner', 'A principal cannot own itself.');
    ownerId = owner.id;
  }
  const profile = profileFields({ what_i_do: patch.what_i_do, contact: patch.contact });
  patchPrincipal(ctx.core, p.id, {
    ...profile,
    ...(Object.keys(profile).length > 0 ? { profile_updated_at: ctx.core.now() } : {}),
    ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
    ...(patch.trust !== undefined ? { trust: patch.trust } : {}),
    ...(ownerId !== undefined ? { owner_id: ownerId } : {}),
    ...(patch.harness !== undefined ? { harness: patch.harness } : {}),
    ...(patch.admin !== undefined ? { can_admin: patch.admin ? 1 : 0 } : {}),
    ...(patch.password !== undefined ? { password_hash: hashPassword(patch.password) } : {}),
    ...(patch.external !== undefined ? { external: patch.external ? 1 : 0 } : {}),
    ...(patch.owner_label !== undefined ? { owner_label: patch.owner_label } : {}),
    ...(patch.limits !== undefined ? { limits: mergeLimits(p, patch.limits) } : {}),
  });
  // Becoming external leaves all-agents (and its ambient grants) and can end parked waits elsewhere.
  if (patch.external !== undefined) ctx.core.waiters.revokePrincipal(p.id);
  return principalView(principalByName(ctx, name), nameIndex(ctx), ctx.core.db, ctx.core.now());
}

export function adminPrincipalSetDisabled(ctx: AccessContext, name: string, disabled: boolean): PrincipalView {
  const p = principalByName(ctx, name);
  guardTarget(ctx, p);
  setDisabled(ctx.core, p, disabled);
  return principalView(principalByName(ctx, name), nameIndex(ctx), ctx.core.db, ctx.core.now());
}

export function adminPrincipalList(ctx: AccessContext, includeDisabled: boolean): PrincipalView[] {
  const names = nameIndex(ctx);
  return allPrincipals(ctx.core)
    .filter((p) => includeDisabled || p.disabled_at === null)
    .map((p) => principalView(p, names, ctx.core.db, ctx.core.now()));
}

// ---------------------------------------------------------------- tokens

export function adminTokenIssue(
  ctx: AccessContext,
  principal: string,
  opts: { label?: string | undefined; days?: number | null | undefined },
): IssuedToken & { view: TokenView } {
  const p = principalByName(ctx, principal);
  guardTarget(ctx, p);
  if (p.kind === 'human') requireSuperadminFor(ctx);
  if (p.disabled_at !== null) throw conflict('principal_disabled');
  let days = opts.days;
  if (p.external === 1) {
    requireHumanFor(ctx, 'issue a token to');
    // The token of an external lives at most its token_days (default 30); renew = issue a new one.
    const max = limitsOf(p).token_days;
    if (max !== null) days = days === undefined || days === null ? max : Math.min(days, max);
  }
  const t = issueToken(ctx.core, p.id, { label: opts.label ?? '', days, createdBy: ctx.principal.id });
  const row = getTokenById(ctx.core.db, t.id)!;
  return { ...t, view: tokenView(row, nameIndex(ctx)) };
}

function tokenInTenant(ctx: AccessContext, id: string): { token: TokenRow; owner: PrincipalRow } {
  const token = getTokenById(ctx.core.db, id);
  if (!token) throw notFound();
  const owner = allPrincipals(ctx.core).find((p) => p.id === token.principal_id);
  if (!owner) throw notFound();
  return { token, owner };
}

export function adminTokenRevoke(ctx: AccessContext, id: string): TokenView {
  const { owner } = tokenInTenant(ctx, id);
  guardTarget(ctx, owner);
  revokeToken(ctx.core, id, ctx.principal.id);
  return tokenView(getTokenById(ctx.core.db, id)!, nameIndex(ctx));
}

export function adminTokenList(ctx: AccessContext, principal: string | undefined, includeRevoked: boolean): TokenView[] {
  const names = nameIndex(ctx);
  const rows = principal !== undefined ? listTokens(ctx.core.db, ctx.core.tenantId, principalByName(ctx, principal).id) : listTokens(ctx.core.db, ctx.core.tenantId);
  return rows.filter((t) => includeRevoked || t.revoked_at === null).map((t) => tokenView(t, names));
}

// ---------------------------------------------------------------- groups

function groupViews(ctx: AccessContext): GroupView[] {
  const names = nameIndex(ctx);
  const members = membersByGroup(ctx.core);
  const principals = allPrincipals(ctx.core);
  return allGroups(ctx.core).map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    system: g.system === 1,
    members:
      g.name === ALL_AGENTS_GROUP && g.system === 1
        ? principals.filter((p) => p.kind === 'agent' && p.disabled_at === null && p.external === 0).map((p) => p.name)
        : (members.get(g.id) ?? []).map((id) => names.get(id) ?? '').filter(Boolean).sort(),
  }));
}

function groupView(ctx: AccessContext, id: string): GroupView {
  const v = groupViews(ctx).find((g) => g.id === id);
  if (!v) throw notFound();
  return v;
}

export function adminGroupCreate(ctx: AccessContext, name: string, description: string): GroupView {
  return groupView(ctx, createGroup(ctx.core, name, description, ctx.principal.id).id);
}

export function adminGroupUpdate(ctx: AccessContext, name: string, patch: { name?: string | undefined; description?: string | undefined }): GroupView {
  const g = groupByName(ctx, name);
  const clean: { name?: string; description?: string } = {};
  if (patch.name !== undefined) clean.name = patch.name;
  if (patch.description !== undefined) clean.description = patch.description;
  return groupView(ctx, renameGroup(ctx.core, g, clean).id);
}

export function adminGroupDelete(ctx: AccessContext, name: string): void {
  deleteGroup(ctx.core, groupByName(ctx, name));
}

export function adminGroupMembersSet(ctx: AccessContext, name: string, members: readonly string[]): GroupView {
  const g = groupByName(ctx, name);
  const rows = [...new Set(members)].map((m) => principalByName(ctx, m));
  const ids = rows.map((r) => r.id);
  const current = new Set(membersByGroup(ctx.core).get(g.id) ?? []);
  if (rows.some((r) => r.external === 1 && !current.has(r.id))) requireHumanFor(ctx, 'add to a group');
  setGroupMembers(ctx.core, g, ids, ctx.principal.id);
  return groupView(ctx, g.id);
}

export function adminGroupList(ctx: AccessContext): GroupView[] {
  return groupViews(ctx);
}

// ---------------------------------------------------------------- grants

export interface GrantKeyInput {
  space: string;
  scope: GrantRow['scope'];
  path_prefix?: string | undefined;
  doc_id?: string | undefined;
  subject: { type: GrantRow['subject_type']; name: string };
}

function grantTarget(ctx: AccessContext, k: GrantKeyInput): GrantTarget {
  const space = spaceBySlug(ctx, k.space);
  let subjectId: string;
  if (k.subject.type === 'principal') {
    const who = principalByName(ctx, k.subject.name);
    if (who.external === 1) requireHumanFor(ctx, 'grant access to');
    subjectId = who.id;
  } else {
    subjectId = groupByName(ctx, k.subject.name).id;
  }
  if (k.scope === 'doc' && k.doc_id !== undefined && !docInSpace(ctx, space.id, k.doc_id)) throw notFound();
  return {
    spaceId: space.id,
    scope: k.scope,
    pathPrefix: k.path_prefix ?? null,
    docId: k.doc_id ?? null,
    subjectType: k.subject.type,
    subjectId,
  };
}

export function grantViews(ctx: AccessContext, rows: readonly GrantRow[]): GrantView[] {
  const names = nameIndex(ctx);
  const groups = new Map(allGroups(ctx.core).map((g) => [g.id, g.name]));
  const spaces = new Map(allSpaces(ctx.core).map((s) => [s.id, s.slug]));
  return rows.map((g) => ({
    id: g.id,
    space: spaces.get(g.space_id) ?? '',
    scope: g.scope,
    path_prefix: g.path_prefix,
    doc_id: g.doc_id,
    subject: { type: g.subject_type, name: (g.subject_type === 'principal' ? names.get(g.subject_id) : groups.get(g.subject_id)) ?? '' },
    role: g.role,
    granted_by: g.granted_by ? (names.get(g.granted_by) ?? null) : null,
    granted_at: g.granted_at,
  }));
}

export function adminGrantSet(ctx: AccessContext, k: GrantKeyInput, role: Role): GrantView {
  if (k.subject.type === 'group' && k.subject.name === ALL_AGENTS_GROUP && role !== 'none') {
    const space = spaceBySlug(ctx, k.space);
    // No ambient access to inbox or proj-* spaces; it would be ignored.
    if (noAmbientGrants(space)) throw invalidInput('subject', `${ALL_AGENTS_GROUP} gives no access to inbox or proj-* spaces; grant principals explicitly.`);
  }
  if (role === 'guest') {
    // Guest is a personal messaging membership of a whole inbox space.
    if (k.scope !== 'space') throw invalidInput('scope', 'guest is a membership of the whole space: use scope "space".');
    if (k.subject.type !== 'principal') throw invalidInput('subject', 'guest is given to a principal, not a group.');
    if (!isInboxSpace(spaceBySlug(ctx, k.space))) throw invalidInput('role', 'guest is for spaces with messages (the inbox setting).');
  }
  const row = setGrant(ctx.core, { ...grantTarget(ctx, k), role }, ctx.principal.id);
  return grantViews(ctx, [row])[0]!;
}

export function adminGrantRemove(ctx: AccessContext, k: GrantKeyInput): void {
  if (!removeGrant(ctx.core, grantTarget(ctx, k))) throw notFound();
}

export function adminGrantList(ctx: AccessContext, filter: { space?: string | undefined; subject?: { type: GrantRow['subject_type']; name: string } | undefined }): GrantView[] {
  let rows = allGrants(ctx.core);
  if (filter.space !== undefined) {
    const s = spaceBySlug(ctx, filter.space);
    rows = rows.filter((g) => g.space_id === s.id);
  }
  if (filter.subject !== undefined) {
    const id = filter.subject.type === 'principal' ? principalByName(ctx, filter.subject.name).id : groupByName(ctx, filter.subject.name).id;
    rows = rows.filter((g) => g.subject_type === filter.subject!.type && g.subject_id === id);
  }
  return grantViews(ctx, rows);
}

// ---------------------------------------------------------------- access explain

export interface ExplainSpace {
  space: string;
  archived: boolean;
  visible: boolean;
  /** Role on the space level. */
  role: Role;
  /** Role on the given target (path / doc_id), if one is given. */
  target?: { path?: string; doc_id?: string; role: Role; level: Resolution['level']; decided_by: GrantView[] };
  /** All grants of the principal and its groups in this space. */
  grants: GrantView[];
  /** The role on the ladder (Guest · Viewer · Editor · Admin) and whether access is custom. */
  member: MemberAccess;
}

export interface ExplainResult {
  principal: PrincipalView;
  groups: string[];
  spaces: ExplainSpace[];
}

/** "Through the agent's eyes": what a principal sees and by which grant. Changes nothing. */
export function adminAccessExplain(
  ctx: AccessContext,
  name: string,
  filter: { space?: string | undefined; path?: string | undefined; doc_id?: string | undefined },
): ExplainResult {
  const row = principalByName(ctx, name);
  const view = contextForRow(ctx.core, row);
  const names = nameIndex(ctx);
  const groups = new Map(allGroups(ctx.core).map((g) => [g.id, g.name]));
  const visible = new Set(visibleSpaces(view).map((v) => v.space.id));
  let spaces = allSpaces(ctx.core);
  if (filter.space !== undefined) spaces = [spaceBySlug(ctx, filter.space)];
  if ((filter.path !== undefined || filter.doc_id !== undefined) && filter.space === undefined) {
    throw invalidInput('space', 'space is required together with path or doc_id.');
  }
  const out: ExplainSpace[] = spaces.map((s) => {
    const mine = (view.snapshot.grantsBySpace.get(s.id) ?? []).filter((g) =>
      g.subject_type === 'principal' ? g.subject_id === row.id : view.groupIds.includes(g.subject_id),
    );
    const entry: ExplainSpace = {
      space: s.slug,
      archived: s.archived_at !== null,
      visible: visible.has(s.id),
      role: explainRole(view, s).role,
      grants: grantViews(ctx, mine),
      member: memberAccess(view, s, visible),
    };
    if (filter.path !== undefined || filter.doc_id !== undefined) {
      const key = filter.path !== undefined ? (filter.path.endsWith('/') ? folderPrefixKey(filter.path, 'path') : pathKey(normalizePath(filter.path))) : undefined;
      // A path naming a live document is explained for that document (the mail read predicate included).
      const docId = filter.doc_id ?? (key !== undefined && !key.endsWith('/') ? getLiveDocViewByPathKey(ctx.core.db, s.id, key)?.id : undefined);
      const r = explainRole(view, s, key, docId);
      entry.target = {
        ...(filter.path !== undefined ? { path: filter.path } : {}),
        ...(filter.doc_id !== undefined ? { doc_id: filter.doc_id } : {}),
        role: r.role,
        level: r.level,
        decided_by: grantViews(ctx, r.decisive),
      };
    }
    return entry;
  });
  return {
    principal: principalView(row, names, ctx.core.db, ctx.core.now()),
    groups: view.groupIds.map((id) => groups.get(id) ?? '').filter(Boolean).sort(),
    spaces: out,
  };
}

// ---------------------------------------------------------------- connect guide

export interface ConnectTarget {
  principal: PrincipalView;
  spaces: { slug: string; role: Role }[];
}

/** For the connection guide (admin_connect_guide): the principal and the spaces it will see. */
export function adminConnectTarget(ctx: AccessContext, name: string): ConnectTarget {
  const row = principalByName(ctx, name);
  const view = contextForRow(ctx.core, row);
  return {
    principal: principalView(row, nameIndex(ctx)),
    spaces: visibleSpaces(view).map((v) => ({ slug: v.space.slug, role: v.role })),
  };
}
