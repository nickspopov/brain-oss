// The single point of permissions. Reads spaces and grants through the snapshot
// (access/snapshot); the role is computed by access/resolve. Documents and revisions for other core
// modules come only from here, already checked.
import {
  getDocLocation,
  getDocView,
  getLiveDocViewByPathKey,
  listDocViews,
  type DocumentView,
} from '../store/documents.js';
import { getProposalView, listProposalViews, type ProposalStatus, type ProposalView } from '../store/proposals.js';
import { feedRows, getRevisionView, listRevisionViews, type FeedQuery, type FeedRow, type RevisionView } from '../store/revisions.js';
import { countRows, docSize, searchRowKeys, termCounts, termInstances, type SearchKeyRow, type SqlFilter, type TermKey } from '../store/search.js';
import type { GrantRow, PrincipalRow, Role, SpaceRow } from '../store/types.js';
import { atLeast, rank, resolveRole, type Resolution } from './access/resolve.js';
import { aclSnapshot, type AclSnapshot } from './access/snapshot.js';
import type { Core } from './context.js';
import { forbidden, invalidInput, notFound } from './errors.js';
import { isInboxSpace } from './handoff.js';
import { normalizePath, pathKey } from './paths.js';
import { parseProtectedPaths } from './spaces.js';
import type { AuthenticatedPrincipal } from './tokens.js';

export { atLeast, rank } from './access/resolve.js';

export interface AccessContext {
  core: Core;
  principal: AuthenticatedPrincipal;
  /** All groups of the principal, including the computed all-agents. */
  groupIds: readonly string[];
  /** Whether the principal is disabled (for the "through the agent's eyes" context; a token caller is always enabled). */
  disabled: boolean;
  snapshot: AclSnapshot;
  /**
   * handoff_send of an external principal: the one recipient folder of one inbox
   * space it may create the message in. Set only on the context of that write.
   */
  inboxSend?: { spaceId: string; folderKey: string } | undefined;
}

/** External principals are never members of the computed group all-agents. */
function groupsFor(snap: AclSnapshot, principalId: string, kind: string, disabled: boolean, external: boolean): string[] {
  const groups = [...(snap.groupsOf.get(principalId) ?? [])];
  if (kind === 'agent' && !disabled && !external && snap.allAgentsGroupId) groups.push(snap.allAgentsGroupId);
  return groups;
}

export function contextFor(core: Core, principal: AuthenticatedPrincipal): AccessContext {
  const snapshot = aclSnapshot(core);
  return { core, principal, groupIds: groupsFor(snapshot, principal.id, principal.kind, false, principal.external === true), disabled: false, snapshot };
}

/** Context of another principal: for admin_access_explain ("through the agent's eyes"). */
export function contextForRow(core: Core, row: PrincipalRow): AccessContext {
  const snapshot = aclSnapshot(core);
  const disabled = row.disabled_at !== null;
  return {
    core,
    principal: { id: row.id, name: row.name, kind: row.kind, role: row.role, trust: row.trust, admin: row.can_admin === 1, external: row.external === 1 },
    groupIds: groupsFor(snapshot, row.id, row.kind, disabled, row.external === 1),
    disabled,
    snapshot,
  };
}

export function isSuperadmin(ctx: AccessContext): boolean {
  return ctx.principal.role === 'superadmin' && ctx.principal.kind === 'human';
}

/** Capability `admin`: superadmin or explicitly granted. */
export function hasAdminCapability(p: AuthenticatedPrincipal): boolean {
  return (p.role === 'superadmin' && p.kind === 'human') || p.admin === true;
}

function baseResolution(ctx: AccessContext, space: SpaceRow, pathKey?: string, docId?: string): Resolution<GrantRow> {
  return resolveRole(
    ctx.snapshot.grantsBySpace.get(space.id) ?? [],
    { principalId: ctx.principal.id, groupIds: ctx.groupIds },
    { pathKey, docId },
    { superadmin: isSuperadmin(ctx), disabled: ctx.disabled, archived: space.archived_at !== null },
  );
}

function resolution(ctx: AccessContext, space: SpaceRow, pathKey?: string, docId?: string): Resolution<GrantRow> {
  const r = baseResolution(ctx, space, pathKey, docId);
  if (isMessageOnly(ctx, space)) return messageOnlyRole(ctx, space, r, pathKey, docId);
  return docId !== undefined ? mailRule(ctx, space, r, docId) : r;
}

const NO_ROLE = { role: 'none', level: 'none', decisive: [], personal: false } as const satisfies Resolution<GrantRow>;
const MAIL_DENIED = { role: 'none', level: 'mail', decisive: [], personal: false } as const satisfies Resolution<GrantRow>;
/** Own mail of a message-only member: read at most (a Guest membership reads its own mail). */
const capRead = (r: Resolution<GrantRow>): Resolution<GrantRow> => (atLeast(r.role, 'guest') ? { ...r, role: 'read' } : r);

/** Sender and recipient of the message backed by this document, if it is one (one PK lookup). */
export function envelopeOf(ctx: AccessContext, docId: string): { sender: string; recipient: string } | undefined {
  return ctx.core.db.prepare('SELECT sender_id AS sender, recipient_id AS recipient FROM handoff_messages WHERE doc_id = ?').get(docId) as
    | { sender: string; recipient: string }
    | undefined;
}

/** Space-level role `admin` (superadmin included): the only role that oversees other people's mail. */
export function isSpaceAdmin(ctx: AccessContext, space: SpaceRow): boolean {
  return !isMessageOnly(ctx, space) && baseResolution(ctx, space).role === 'admin';
}

/**
 * THE mail read predicate. A message — its envelope and
 * its backing document, every revision, its metadata — is readable only by its sender, its recipient,
 * or an Admin of its space (role `admin` on the space level; the instance superadmin is admin
 * everywhere: the separate global exception). Ordinary space/path/doc read/write/admin grants never
 * reveal other people's mail; explicit narrower denies still apply (the grant role is the upper
 * bound). Every surface goes through `roleAt` with the document id or `readableDocsFilter` (SQL),
 * so it is enforced here only. Denied = `none` = `not_found` (no existence leak).
 */
function mailRule(ctx: AccessContext, space: SpaceRow, r: Resolution<GrantRow>, docId: string): Resolution<GrantRow> {
  if (r.role === 'none') return r;
  const m = envelopeOf(ctx, docId);
  if (!m || m.sender === ctx.principal.id || m.recipient === ctx.principal.id) return r;
  return isSpaceAdmin(ctx, space) ? r : MAIL_DENIED;
}

/** A personal space-level `guest` grant in this space. */
export function hasGuestGrant(snap: AclSnapshot, spaceId: string, principalId: string): boolean {
  return (snap.grantsBySpace.get(spaceId) ?? []).some((g) => g.scope === 'space' && g.subject_type === 'principal' && g.subject_id === principalId && g.role === 'guest');
}

/**
 * Message-only membership of an inbox space: role Guest, or an external principal
 * (external × inbox is exactly Guest; its own code path and texts stay).
 */
export function isMessageOnly(ctx: AccessContext, space: SpaceRow): boolean {
  if (!isInboxSpace(space)) return false;
  return ctx.principal.external === true || hasGuestGrant(ctx.snapshot, space.id, ctx.principal.id);
}

/**
 * A message-only member in an inbox space (Guest; an external): whatever its grants there,
 * it only reads messages it sent or received and its own folder, and writes only the message its own
 * handoff_send creates. No listing, search, `_agents/` or other documents of that space. In other
 * spaces its grants apply as for anyone (a human may grant normal roles).
 */
function messageOnlyRole(ctx: AccessContext, space: SpaceRow, r: Resolution<GrantRow>, key?: string, docId?: string): Resolution<GrantRow> {
  if (r.level === 'disabled' || r.level === 'archived') return r;
  const send = ctx.inboxSend;
  // A Guest sends with its membership; an external with its grant there (as before).
  if (send && send.spaceId === space.id && key !== undefined && key.startsWith(send.folderKey)) return r.role === 'guest' ? { ...r, role: 'write' } : r;
  if (docId !== undefined) {
    const m = envelopeOf(ctx, docId);
    if (m && (m.sender === ctx.principal.id || m.recipient === ctx.principal.id)) return capRead(r);
  }
  if (key !== undefined && key.startsWith(`${ctx.principal.name.toLowerCase()}/`)) return capRead(r);
  return NO_ROLE;
}

/** Role on the space, path (path_key) and document. */
export function roleAt(ctx: AccessContext, space: SpaceRow, pathKey?: string, docId?: string): Role {
  return resolution(ctx, space, pathKey, docId).role;
}

/** Role together with the grant that determined it (admin_access_explain). */
export function explainRole(ctx: AccessContext, space: SpaceRow, pathKey?: string, docId?: string): Resolution<GrantRow> {
  return resolution(ctx, space, pathKey, docId);
}

export interface VisibleSpace {
  space: SpaceRow;
  /** Role on the space level; may be `none` if visible only through a narrower grant. */
  role: Role;
}

/** Whether a space is visible: space-level role ≥ read or a narrower grant ≥ read. */
function visibility(ctx: AccessContext, space: SpaceRow): VisibleSpace | null {
  // A message-only member (Guest, external) sees an inbox space only through its handoff tools.
  if (isMessageOnly(ctx, space)) {
    return ctx.inboxSend?.spaceId === space.id ? { space, role: 'none' } : null;
  }
  const role = roleAt(ctx, space);
  if (atLeast(role, 'read')) return { space, role };
  if (ctx.disabled || (space.archived_at !== null && !isSuperadmin(ctx))) return null;
  for (const g of ctx.snapshot.grantsBySpace.get(space.id) ?? []) {
    if (g.scope === 'space' || !atLeast(g.role, 'read')) continue;
    const mine = g.subject_type === 'principal' ? g.subject_id === ctx.principal.id : ctx.groupIds.includes(g.subject_id);
    if (!mine) continue;
    // A narrower grant counts only if it really gives read on its target
    // (a personal `none` at the same level overrides it).
    const r = g.scope === 'doc' ? roleAt(ctx, space, undefined, g.doc_id ?? undefined) : roleAt(ctx, space, g.path_prefix ?? undefined);
    if (atLeast(r, 'read')) return { space, role };
  }
  return null;
}

/** Spaces visible to the caller, by slug. */
export function visibleSpaces(ctx: AccessContext): VisibleSpace[] {
  const out: VisibleSpace[] = [];
  for (const s of ctx.snapshot.spaces) {
    const v = visibility(ctx, s);
    if (v) out.push(v);
  }
  return out;
}

/** Ids of spaces with any grant ≥ read: a preliminary SQL narrowing. */
export function candidateSpaceIds(ctx: AccessContext): string[] {
  return visibleSpaces(ctx).map((v) => v.space.id);
}

/**
 * Space by slug or `not_found` (invisible is indistinguishable from non-existent);
 * `forbidden` only if the space is visible but the space-level role is insufficient.
 */
export function requireSpace(ctx: AccessContext, slug: string, min: Role): VisibleSpace {
  const space = ctx.snapshot.spaceBySlug.get(slug);
  const v = space ? visibility(ctx, space) : null;
  if (!v) throw notFound();
  if (min !== 'read' && rank(v.role) < rank(min)) throw forbidden(min);
  return v;
}

export interface DocRow {
  space_id: string;
  /** path_key of the document. */
  path_key: string;
  doc_id: string;
}

/** Keeps rows where the role is ≥ read. Call before limit, counts and snippets. */
export function filterDocs<T extends DocRow>(ctx: AccessContext, rows: readonly T[]): T[] {
  return rows.filter((r) => {
    const space = ctx.snapshot.spaceById.get(r.space_id);
    return space !== undefined && atLeast(roleAt(ctx, space, r.path_key, r.doc_id), 'read');
  });
}

/**
 * For admin_grant_set with scope = doc: the document must be in this space.
 * The caller is an administrator, so the document's visibility does not matter to them.
 */
export function docInSpace(ctx: AccessContext, spaceId: string, docId: string): boolean {
  const loc = getDocLocation(ctx.core.db, docId);
  return loc !== undefined && loc.space_id === spaceId;
}

// --- Documents and revisions ---------------------------------------------------------------

export type { DocumentView } from '../store/documents.js';
export type { RevisionView } from '../store/revisions.js';

/** `{ id }` or `{ space, path }`. */
export interface DocRefInput {
  id?: string | undefined;
  space?: string | undefined;
  path?: string | undefined;
}

export interface DocAccess {
  space: SpaceRow;
  doc: DocumentView;
  role: Role;
}

/** Exactly one form of reference: `id` or the pair `space` + `path`. */
export function checkDocRef(ref: DocRefInput): void {
  const byId = ref.id !== undefined;
  const byPath = ref.space !== undefined || ref.path !== undefined;
  if (byId === byPath || (byPath && (ref.space === undefined || ref.path === undefined))) {
    throw invalidInput('id', 'Pass either id, or space and path.');
  }
}

function accessTo(ctx: AccessContext, doc: DocumentView | undefined, min: Role): DocAccess {
  if (!doc) throw notFound();
  const space = ctx.snapshot.spaceById.get(doc.space_id);
  if (!space) throw notFound();
  const role = roleAt(ctx, space, doc.path_key, doc.id);
  if (!atLeast(role, 'read')) throw notFound();
  if (!atLeast(role, min)) throw forbidden(min);
  return { space, doc, role };
}

/**
 * Document by `id` or (`space`, `path`) with a role of at least `min`. No document or no
 * `read` → `not_found` with the same text; `forbidden` only when `read` is present.
 * By path only a live document is found; a deleted one by `id` with `includeDeleted`.
 */
export function requireDoc(ctx: AccessContext, ref: DocRefInput, min: Role, opts: { includeDeleted?: boolean } = {}): DocAccess {
  checkDocRef(ref);
  if (ref.id !== undefined) {
    const doc = getDocView(ctx.core.db, ref.id);
    if (doc && doc.deleted_at !== null && !opts.includeDeleted) throw notFound();
    return accessTo(ctx, doc, min);
  }
  const space = ctx.snapshot.spaceBySlug.get(ref.space!);
  if (!space || !visibility(ctx, space)) throw notFound();
  const key = pathKey(normalizePath(ref.path!));
  return accessTo(ctx, getLiveDocViewByPathKey(ctx.core.db, space.id, key), min);
}

export interface WriteTarget {
  space: SpaceRow;
  path: string;
  pathKey: string;
  /** Live document at this path, if any. */
  existing: DocumentView | undefined;
  role: Role;
}

/**
 * Write target by (`space`, `path`): role on the path (and on the document, if there is one). Role
 * below `read` → `not_found`; below `min` → `forbidden`.
 */
export function requireWriteTarget(ctx: AccessContext, slug: string, rawPath: string, min: Role, field = 'path'): WriteTarget {
  const space = ctx.snapshot.spaceBySlug.get(slug);
  if (!space || !visibility(ctx, space)) throw notFound();
  return requirePathIn(ctx, space, rawPath, min, field);
}

/** The same for a space already found through guard. */
export function requirePathIn(ctx: AccessContext, space: SpaceRow, rawPath: string, min: Role, field = 'path'): WriteTarget {
  const path = normalizePath(rawPath, field);
  const key = pathKey(path);
  const existing = getLiveDocViewByPathKey(ctx.core.db, space.id, key);
  const role = roleAt(ctx, space, key, existing?.id);
  if (!atLeast(role, 'read')) throw notFound();
  if (!atLeast(role, min)) throw forbidden(min);
  return { space, path, pathKey: key, existing, role };
}

/** Re-read a document after a write in the same transaction (access already checked by the caller). */
export function reloadDoc(ctx: AccessContext, id: string): DocumentView {
  const doc = getDocView(ctx.core.db, id);
  if (!doc) throw notFound();
  return doc;
}

/** Documents of a space under a folder prefix, visible to the caller. */
export function visibleDocsIn(ctx: AccessContext, space: SpaceRow, prefixKey: string, includeDeleted: boolean): DocumentView[] {
  return listDocViews(ctx.core.db, space.id, prefixKey, includeDeleted).filter((d) =>
    atLeast(roleAt(ctx, space, d.path_key, d.id), 'read'),
  );
}

/** A revision of a document the caller already has access to. */
export function revisionOf(ctx: AccessContext, access: DocAccess, rev: number): RevisionView {
  const r = getRevisionView(ctx.core.db, access.doc.id, rev);
  if (!r) throw notFound();
  return filterRevisions(ctx, [r])[0]!;
}

/** Revisions of a document (newest first) with a number below `beforeRev`, already filtered. */
export function revisionsOf(ctx: AccessContext, access: DocAccess, beforeRev: number, limit: number): RevisionView[] {
  return filterRevisions(ctx, listRevisionViews(ctx.core.db, access.doc.id, beforeRev, limit));
}

/**
 * Revision filter: the document is already checked by its current location; earlier locations
 * (`path` and `prev_path` of old revisions) are hidden if there is no `read` role at that place.
 */
export function filterRevisions(ctx: AccessContext, rows: readonly RevisionView[]): RevisionView[] {
  const readable = (spaceId: string | null, path: string | null, docId: string): boolean => {
    if (spaceId === null || path === null) return false;
    const space = ctx.snapshot.spaceById.get(spaceId);
    return space !== undefined && atLeast(roleAt(ctx, space, pathKey(path), docId), 'read');
  };
  return rows.map((r) => {
    const hidePath = !readable(r.space_id, r.path, r.doc_id);
    const hidePrev = r.prev_path !== null && !readable(r.prev_space_id, r.prev_path, r.doc_id);
    if (!hidePath && !hidePrev) return r;
    return {
      ...r,
      ...(hidePath ? { path: '' } : {}),
      ...(hidePrev ? { prev_path: null, prev_space_id: null } : {}),
    };
  });
}

/** `AGENTS.md` at the root of the space, if the caller has `read` on it. */
export function readableAgentsMd(ctx: AccessContext, space: SpaceRow): DocumentView | undefined {
  const doc = getLiveDocViewByPathKey(ctx.core.db, space.id, 'agents.md');
  if (!doc) return undefined;
  return atLeast(roleAt(ctx, space, doc.path_key, doc.id), 'read') ? doc : undefined;
}

/**
 * True iff the caller has `write` on `space/path` and no live document exists there (orientation
 * onboarding). Invisible spaces give false, so the answer does not reveal them.
 */
export function canCreateAt(ctx: AccessContext, slug: string, path: string): boolean {
  const space = ctx.snapshot.spaceBySlug.get(slug);
  if (!space || !visibility(ctx, space)) return false;
  const key = pathKey(normalizePath(path));
  if (!atLeast(roleAt(ctx, space, key), 'write')) return false;
  return getLiveDocViewByPathKey(ctx.core.db, space.id, key) === undefined;
}

/**
 * The highest role the caller has anywhere: on a visible space or through a narrower grant
 * (orientation: tool list hygiene and the capability line of start_here).
 */
export function highestRole(ctx: AccessContext): Role {
  let best: Role = 'none';
  const better = (r: Role) => {
    if (rank(r) > rank(best)) best = r;
  };
  for (const { space, role } of visibleSpaces(ctx)) {
    better(role);
    for (const g of ctx.snapshot.grantsBySpace.get(space.id) ?? []) {
      if (g.scope === 'space' || rank(g.role) <= rank(best)) continue;
      const mine = g.subject_type === 'principal' ? g.subject_id === ctx.principal.id : ctx.groupIds.includes(g.subject_id);
      if (!mine) continue;
      better(g.scope === 'doc' ? roleAt(ctx, space, undefined, g.doc_id ?? undefined) : roleAt(ctx, space, g.path_prefix ?? undefined));
    }
  }
  return best;
}

// --- Sets: search and feed -------------------------------------------------------------------

export type { FeedRow } from '../store/revisions.js';
export type { SearchKeyRow, SqlFilter, TermKey } from '../store/search.js';

/**
 * SQL condition "role ≥ read on document `d`" (the permission filter is in the SQL itself, before the
 * limit and ranking). For each visible space the caller's grants are compiled into a CASE in the same
 * order as role resolution: document → longest prefix → space. The result matches
 * `roleAt` for any document; the sets still go through `filterDocs` as a second step.
 */
export function readableDocsFilter(ctx: AccessContext, onlySpaceIds?: readonly string[]): SqlFilter {
  const only = onlySpaceIds ? new Set(onlySpaceIds) : null;
  const parts: string[] = [];
  const params: (string | number)[] = [];
  for (const { space } of visibleSpaces(ctx)) {
    if (only && !only.has(space.id)) continue;
    if (isSuperadmin(ctx)) {
      parts.push('d.space_id = ?');
      params.push(space.id);
      continue;
    }
    const mine = (ctx.snapshot.grantsBySpace.get(space.id) ?? []).filter((g) =>
      g.subject_type === 'principal' ? g.subject_id === ctx.principal.id : ctx.groupIds.includes(g.subject_id),
    );
    const cases: string[] = [];
    const caseParams: (string | number)[] = [];
    const docIds = [...new Set(mine.filter((g) => g.scope === 'doc' && g.doc_id !== null).map((g) => g.doc_id!))];
    for (const id of docIds) {
      cases.push('WHEN d.id = ? THEN ?');
      caseParams.push(id, atLeast(roleAt(ctx, space, undefined, id), 'read') ? 1 : 0);
    }
    const prefixes = [...new Set(mine.filter((g) => g.scope === 'path' && g.path_prefix !== null).map((g) => g.path_prefix!))].sort(
      (a, b) => b.length - a.length,
    );
    for (const p of prefixes) {
      cases.push('WHEN substr(d.path_key, 1, ?) = ? THEN ?');
      // substr in SQLite counts characters (code points), not UTF-16 units.
      caseParams.push([...p].length, p, atLeast(roleAt(ctx, space, p), 'read') ? 1 : 0);
    }
    const spaceReadable = atLeast(roleAt(ctx, space), 'read') ? 1 : 0;
    // The mail read predicate (mailRule) in SQL: other people's messages only for a space Admin.
    const mail = isSpaceAdmin(ctx, space) ? '' : ` AND ${MAIL_SQL}`;
    const mailParams = mail === '' ? [] : [ctx.principal.id, ctx.principal.id];
    if (cases.length === 0) {
      if (spaceReadable === 0) continue;
      parts.push(mail === '' ? 'd.space_id = ?' : `(d.space_id = ?${mail})`);
      params.push(space.id, ...mailParams);
      continue;
    }
    parts.push(`(d.space_id = ? AND (CASE ${cases.join(' ')} ELSE ? END) = 1${mail})`);
    params.push(space.id, ...caseParams, spaceReadable, ...mailParams);
  }
  return parts.length === 0 ? { sql: '0', params: [] } : { sql: parts.join(' OR '), params };
}

/** `mailRule` for a non-admin caller: `d` is not someone else's message (params: caller id twice). */
const MAIL_SQL = 'NOT EXISTS (SELECT 1 FROM handoff_messages hm WHERE hm.doc_id = d.id AND hm.sender_id <> ? AND hm.recipient_id <> ?)';

/** Visible spaces from a list of slugs; invisible and non-existent ones are silently dropped. */
export function visibleSpaceIdsBySlug(ctx: AccessContext, slugs: readonly string[]): string[] {
  const out: string[] = [];
  for (const slug of slugs) {
    const space = ctx.snapshot.spaceBySlug.get(slug);
    if (space && visibility(ctx, space) && !out.includes(space.id)) out.push(space.id);
  }
  return out;
}

export interface SearchCandidatesInput {
  match: string;
  spaceIds?: readonly string[] | undefined;
  pathPrefixKey?: string | undefined;
  cap: number;
}

/** Search candidates: the permission condition in SQL before the limit, then filterDocs. */
export function searchCandidateKeys(ctx: AccessContext, q: SearchCandidatesInput): SearchKeyRow[] {
  const filter = readableDocsFilter(ctx, q.spaceIds);
  return filterDocs(ctx, searchRowKeys(ctx.core.db, { match: q.match, filter, pathPrefixKey: q.pathPrefixKey, cap: q.cap }));
}

/**
 * Ranking statistics over candidates that already passed the filter: column lengths and
 * term occurrences only for documents in `nums`; nothing else from the index leaks out.
 */
export function candidateSizes(ctx: AccessContext, nums: readonly number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const n of nums) {
    const sz = docSize(ctx.core.db, n);
    if (sz) out.set(n, sz);
  }
  return out;
}

export function candidateTermCounts(ctx: AccessContext, key: TermKey, nums: ReadonlySet<number>): { doc: number; col: string; n: number }[] {
  return termCounts(ctx.core.db, key).filter((r) => nums.has(r.doc));
}

export function candidateTermInstances(ctx: AccessContext, key: TermKey, nums: ReadonlySet<number>): { doc: number; col: string; offset: number }[] {
  return termInstances(ctx.core.db, key).filter((r) => nums.has(r.doc));
}

/** Number of visible live documents (matching, if given): ranking statistics. */
export function countReadableDocs(ctx: AccessContext, match?: string): number {
  return countRows(ctx.core.db, readableDocsFilter(ctx), match);
}

/** Views of visible documents by id (order preserved, invisible ones drop out). */
export function readableDocViews(ctx: AccessContext, ids: readonly string[]): DocumentView[] {
  const out: DocumentView[] = [];
  for (const id of ids) {
    const d = getDocView(ctx.core.db, id);
    if (!d) continue;
    const space = ctx.snapshot.spaceById.get(d.space_id);
    if (space && atLeast(roleAt(ctx, space, d.path_key, d.id), 'read')) out.push(d);
  }
  return out;
}

export type FeedInput = Omit<FeedQuery, 'filter' | 'spaceIds'> & { spaceIds?: readonly string[] | undefined };

/**
 * Revision feed: permissions by the **current** location of the document, in SQL and then filterDocs;
 * earlier locations are hidden by filterRevisions.
 */
export function feed(ctx: AccessContext, q: FeedInput): FeedRow[] {
  const filter = readableDocsFilter(ctx, q.spaceIds);
  const rows = feedRows(ctx.core.db, { ...q, filter, ...(q.spaceIds ? { spaceIds: q.spaceIds } : {}) });
  const keep = new Set(
    filterDocs(
      ctx,
      rows.map((r) => ({ space_id: r.doc_space_id, path_key: r.doc_path_key, doc_id: r.doc_id, seq: r.seq })),
    ).map((r) => r.seq),
  );
  const kept = rows.filter((r) => keep.has(r.seq));
  return filterRevisions(ctx, kept) as FeedRow[];
}

// --- Proposals -------------------------------------------------------------------------------

export type { ProposalView } from '../store/proposals.js';

export interface ProposalAccess {
  proposal: ProposalView;
  space: SpaceRow;
  /** Current target path: the document's location now; for a new document, the proposal's path. */
  path: string;
  /** Target document (in any state), if the proposal is about an existing one. */
  doc: DocumentView | undefined;
  /** Caller's role on the target. */
  role: Role;
}

/**
 * A proposal is visible to its author and to those with `admin` on the target path; both need
 * current `read` on the target. Otherwise `null` (outside: `not_found`).
 */
function proposalAccessOf(ctx: AccessContext, p: ProposalView): ProposalAccess | null {
  const doc = p.doc_id !== null ? getDocView(ctx.core.db, p.doc_id) : undefined;
  if (p.doc_id !== null && !doc) return null;
  const space = ctx.snapshot.spaceById.get(doc?.space_id ?? p.space_id);
  if (!space) return null;
  const path = doc?.path ?? p.path;
  const role = roleAt(ctx, space, doc?.path_key ?? pathKey(path), doc?.id);
  if (!atLeast(role, 'read')) return null;
  if (p.author_id !== ctx.principal.id && !atLeast(role, 'admin')) return null;
  return { proposal: p, space, path, doc, role };
}

/** Proposal by id: invisible is indistinguishable from non-existent; `forbidden` only for a visible one. */
export function requireProposal(ctx: AccessContext, id: string, min: 'read' | 'admin'): ProposalAccess {
  const p = getProposalView(ctx.core.db, id);
  const a = p ? proposalAccessOf(ctx, p) : null;
  if (!a) throw notFound();
  if (min === 'admin' && !atLeast(a.role, 'admin')) throw forbidden('admin');
  return a;
}

export interface ProposalPage {
  items: ProposalAccess[];
  /** The last examined row, if the listing is not exhausted (continuation cursor). */
  nextOrd?: number;
}

const PROPOSAL_BATCH = 200;
const PROPOSAL_SCAN_CAP = 2000;

/**
 * Visible proposals (newest first): SQL narrowed to visible spaces, then a visibility filter
 * on each row up to `limit`.
 */
export function visibleProposals(
  ctx: AccessContext,
  q: { spaceIds: readonly string[]; status?: ProposalStatus | undefined; authorId?: string | undefined; beforeOrd?: number | undefined; limit: number },
): ProposalPage {
  const items: ProposalAccess[] = [];
  let before = q.beforeOrd;
  let scanned = 0;
  for (;;) {
    const rows = listProposalViews(ctx.core.db, { spaceIds: q.spaceIds, status: q.status, authorId: q.authorId, beforeOrd: before, limit: PROPOSAL_BATCH });
    for (const r of rows) {
      scanned++;
      const a = proposalAccessOf(ctx, r);
      if (a) {
        if (items.length === q.limit) return { items, nextOrd: items[items.length - 1]!.proposal.ord };
        items.push(a);
      }
      before = r.ord;
      if (scanned >= PROPOSAL_SCAN_CAP) return { items, nextOrd: r.ord };
    }
    if (rows.length < PROPOSAL_BATCH) return { items };
  }
}

// --- Export ------------------------------------------------------------------------------------

export interface ExportDoc {
  access: DocAccess;
  /** Revisions in ascending order, already filtered (hidden earlier locations have an empty path). */
  revisions: RevisionView[];
}

export interface ExportSet {
  space: SpaceRow;
  docs: ExportDoc[];
}

/**
 * Export content: `head` needs role `read` on the space (visible), live documents with a single
 * head revision; `full` needs role `admin` at the space level, all revisions and deleted documents.
 * In both modes everything the caller has no `read` on is skipped (a narrow `none` applies even to
 * the space administrator).
 */
export function exportSet(ctx: AccessContext, slug: string, mode: 'head' | 'full'): ExportSet {
  const { space } = requireSpace(ctx, slug, mode === 'full' ? 'admin' : 'read');
  const docs: ExportDoc[] = [];
  for (const doc of visibleDocsIn(ctx, space, '', mode === 'full')) {
    const access: DocAccess = { space, doc, role: roleAt(ctx, space, doc.path_key, doc.id) };
    const rows =
      mode === 'full'
        ? listRevisionViews(ctx.core.db, doc.id, doc.head_rev + 1, doc.head_rev).reverse()
        : [getRevisionView(ctx.core.db, doc.id, doc.head_rev)!];
    docs.push({ access, revisions: filterRevisions(ctx, rows) });
  }
  return { space, docs };
}

/**
 * Before handing out a finished archive: the space is still visible (for `full`, role `admin`),
 * and every document in the archive exists and is readable by the caller at its current location.
 */
export function exportStillReadable(ctx: AccessContext, spaceId: string, mode: 'head' | 'full', docIds: readonly string[]): boolean {
  const space = ctx.snapshot.spaceById.get(spaceId);
  if (!space) return false;
  const v = visibility(ctx, space);
  if (!v) return false;
  if (mode === 'full' && !atLeast(v.role, 'admin')) return false;
  for (const id of docIds) {
    const doc = getDocView(ctx.core.db, id);
    if (!doc || doc.space_id !== spaceId) return false;
    if (!atLeast(roleAt(ctx, space, doc.path_key, doc.id), 'read')) return false;
  }
  return true;
}

/**
 * `protected_paths` of the space visible to the caller: a path from a folder where the caller has
 * no `read` is the name of an invisible document or folder; it is not shown.
 */
export function visibleProtectedPaths(ctx: AccessContext, space: SpaceRow): string[] {
  return parseProtectedPaths(space).filter((p) => atLeast(roleAt(ctx, space, pathKey(p)), 'read'));
}
