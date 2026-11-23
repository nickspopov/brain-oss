// Handoff messages: a message is an ordinary document
// plus one envelope row (`handoff_messages`). The commit hook registers every create under
// `<inbox space>/<principal name>/`; status is derived from the row and never stored in frontmatter.
// Any space with the `inbox` setting is an inbox space; recipients, lists and hints
// are per space and only ever cover inbox spaces the caller can see.
import type { Db } from '../db/open.js';
import { recordMailEvent } from '../store/mailevents.js';
import type { PrincipalRow, SpaceRow } from '../store/types.js';
import { readTextBlob } from './blobs.js';
import type { Core } from './context.js';
import { iso } from './docview.js';
import { atLeast, contextForRow, isMessageOnly, roleAt, visibleSpaces, type AccessContext } from './guard.js';
import { AGENTS_DIR, closestName, HANDOFF_SPACE, isInboxSpace, recipientNote } from './handoff.js';
import { pathKey } from './paths.js';

export type MessageStatus = 'new' | 'updated' | 'received' | 'done' | 'declined';
export const MESSAGE_STATUSES: readonly MessageStatus[] = ['new', 'updated', 'received', 'done', 'declined'];
/** Days a done or declined message stays before it expires (when the space has no TTL of its own). */
export const RESOLVED_TTL_DAYS = 14;
/** Messages shown in start_here. */
export const INBOX_SHOWN = 5;
/** Messages returned by one handoff_inbox call. */
export const INBOX_PAGE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MessageRow {
  doc_id: string;
  tenant_id: string;
  sender_id: string;
  recipient_id: string;
  thread_id: string;
  reply_to: string | null;
  created_at: number;
  content_rev: number;
  changed_at: number;
  received_rev: number | null;
  received_at: number | null;
  resolution: 'done' | 'declined' | null;
  resolved_rev: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  note: string | null;
}

type StatusFields = Pick<MessageRow, 'content_rev' | 'received_rev' | 'resolution' | 'resolved_rev'>;

export function statusOf(m: StatusFields): MessageStatus {
  if (m.resolution !== null && m.resolved_rev !== null && m.resolved_rev >= m.content_rev) return m.resolution;
  if (m.received_rev === null) return 'new';
  if (m.received_rev < m.content_rev) return 'updated';
  return 'received';
}

/** Not received at the current content: the recipient is reminded. */
export const isWaiting = (s: MessageStatus): boolean => s === 'new' || s === 'updated';
export const isResolved = (s: MessageStatus): boolean => s === 'done' || s === 'declined';

export function getMessage(db: Db, docId: string): MessageRow | undefined {
  return db.prepare('SELECT * FROM handoff_messages WHERE doc_id = ?').get(docId) as MessageRow | undefined;
}

// --- Recipients --------------------------------------------------------------------------------------
// A valid recipient is an enabled, non-system principal with an explicit
// principal grant (≥ read) in that inbox space — not through a group, not through superadmin or the
// admin capability — and read on its own folder `<space>/<name>/` through the guard. Everyone else —
// unknown, disabled, only in other spaces, only broad readers — is treated identically: not
// addressable, never suggested.

export interface Recipient {
  id: string;
  name: string;
  display_name: string;
  external: boolean;
  owner_label: string | null;
  owner_id: string | null;
}

const ENABLED = "SELECT * FROM principals WHERE tenant_id = ? AND kind != 'system' AND disabled_at IS NULL";

/**
 * An explicit principal grant (≥ guest: Guest, or read and up) of this principal in this space:
 * membership of an inbox space.
 */
export function hasExplicitGrant(ctx: AccessContext, space: SpaceRow, principalId: string): boolean {
  return (ctx.snapshot.grantsBySpace.get(space.id) ?? []).some((g) => g.subject_type === 'principal' && g.subject_id === principalId && atLeast(g.role, 'guest'));
}

function canReceive(core: Core, space: SpaceRow, row: PrincipalRow): boolean {
  if (!isInboxSpace(space)) return false;
  const ctx = contextForRow(core, row);
  return hasExplicitGrant(ctx, space, row.id) && atLeast(roleAt(ctx, space, `${row.name.toLowerCase()}/`), 'read');
}

const recipientOf = (r: PrincipalRow): Recipient => ({
  id: r.id,
  name: r.name,
  display_name: r.display_name,
  external: r.external === 1,
  owner_label: r.owner_label,
  owner_id: r.owner_id,
});

/** All valid recipients in this inbox space, by name. */
export function handoffRecipients(core: Core, space: SpaceRow): Recipient[] {
  return (core.db.prepare(`${ENABLED} ORDER BY name`).all(core.tenantId) as PrincipalRow[])
    .filter((r) => canReceive(core, space, r))
    .map(recipientOf);
}

/** The valid recipient with this exact name (case-insensitive), if any. */
export function recipientNamed(core: Core, space: SpaceRow, name: string): Recipient | undefined {
  const row = core.db.prepare(`${ENABLED} AND name = ?`).get(core.tenantId, name.trim().toLowerCase()) as PrincipalRow | undefined;
  return row && canReceive(core, space, row) ? recipientOf(row) : undefined;
}

/** Top-level folder of a handoff path, or undefined for top-level files and `_agents/`. */
function folderOf(path: string): string | undefined {
  const slash = path.indexOf('/');
  if (slash <= 0) return undefined;
  const folder = path.slice(0, slash);
  return folder.toLowerCase() === AGENTS_DIR ? undefined : folder;
}

/** Valid recipient whose name is the top-level folder of `path`. */
export function recipientFor(core: Core, space: SpaceRow, path: string): Recipient | undefined {
  const folder = folderOf(path);
  return folder === undefined ? undefined : recipientNamed(core, space, folder);
}

function holdsDocuments(core: Core, space: SpaceRow, folder: string, path: string): boolean {
  const prefix = `${pathKey(folder)}/`;
  const row = core.db
    .prepare(
      `SELECT 1 FROM documents d WHERE d.space_id = ? AND d.deleted_at IS NULL AND substr(d.path_key, 1, ?) = ? AND d.path_key <> ?
         AND NOT EXISTS (SELECT 1 FROM handoff_messages m WHERE m.doc_id = d.id) LIMIT 1`,
    )
    .get(space.id, [...prefix].length, prefix, pathKey(path));
  return row !== undefined;
}

/**
 * Note for a document created at `path` in the handoff space whose top-level folder is neither
 * `_agents` nor a valid recipient; undefined when the address is fine. Suggests only valid recipients.
 */
export function recipientCheck(core: Core, space: SpaceRow, path: string): string | undefined {
  if (!isInboxSpace(space)) return undefined;
  const folder = folderOf(path);
  if (folder === undefined || recipientNamed(core, space, folder)) return undefined;
  // A project space with messages on has ordinary folders; one that already holds
  // other documents (not messages) is not a mistyped address.
  if (holdsDocuments(core, space, folder, path)) return undefined;
  return recipientNote(folder, closestName(handoffRecipients(core, space).map((r) => r.name), folder));
}

// --- Commit hook -------------------------------------------------------------------------------------

export type MessagePlan =
  | { kind: 'create'; recipientId: string; pendingAfter: true }
  | { kind: 'update'; row: MessageRow; bodyChanged: boolean; pendingAfter: boolean };

/**
 * What a new revision means for the message (called inside commit, before the document row is
 * written): a create under `handoff/<name>/` registers one; a body change reopens one. `pendingAfter`
 * — the message is not done/declined after this revision, so the document must not expire.
 */
export function planMessage(
  core: Core,
  space: SpaceRow,
  existing: { id: string } | undefined,
  path: string,
  kind: string,
  bodyChanged: boolean,
): MessagePlan | undefined {
  if (!isInboxSpace(space)) return undefined;
  if (!existing) {
    if (kind !== 'create' && kind !== 'import') return undefined;
    const to = recipientFor(core, space, path);
    return to ? { kind: 'create', recipientId: to.id, pendingAfter: true } : undefined;
  }
  const row = getMessage(core.db, existing.id);
  if (!row) return undefined;
  if (bodyChanged) return { kind: 'update', row, bodyChanged: true, pendingAfter: true };
  return { kind: 'update', row, bodyChanged: false, pendingAfter: !isResolved(statusOf(row)) };
}

/** Applies the plan after the revision is written (same transaction). */
export function applyMessagePlan(db: Db, plan: MessagePlan, at: { tenantId: string; docId: string; rev: number; senderId: string; now: number }): void {
  if (plan.kind === 'create') {
    db.prepare(
      `INSERT INTO handoff_messages (doc_id, tenant_id, sender_id, recipient_id, thread_id, reply_to, created_at, content_rev, changed_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(at.docId, at.tenantId, at.senderId, plan.recipientId, at.docId, at.now, at.rev, at.now);
    recordMailEvent(db, { tenantId: at.tenantId, principalId: plan.recipientId, docId: at.docId, rev: at.rev, kind: 'inbound', now: at.now });
    return;
  }
  if (plan.bodyChanged) {
    db.prepare('UPDATE handoff_messages SET content_rev = ?, changed_at = ? WHERE doc_id = ?').run(at.rev, at.now, at.docId);
    recordMailEvent(db, { tenantId: at.tenantId, principalId: plan.row.recipient_id, docId: at.docId, rev: at.rev, kind: 'updated', now: at.now });
  }
}

export function setThread(db: Db, docId: string, threadId: string, replyTo: string): void {
  db.prepare('UPDATE handoff_messages SET thread_id = ?, reply_to = ? WHERE doc_id = ?').run(threadId, replyTo, docId);
}

/** Expiry of a resolved message: the space TTL (or 14 days) from now. */
export function resolvedExpiry(space: Pick<SpaceRow, 'ttl_days'>, now: number): number {
  return now + (space.ttl_days ?? RESOLVED_TTL_DAYS) * DAY_MS;
}

// --- Listing -----------------------------------------------------------------------------------------

export interface MessageListRow extends MessageRow {
  space_id: string;
  space_slug: string;
  path: string;
  path_key: string;
  title: string;
  head_rev: number;
  sender_name: string;
  recipient_name: string;
  resolver_name: string | null;
  sender_external: 0 | 1;
  sender_owner_label: string | null;
  recipient_external: 0 | 1;
  content_hash: string;
  doc_kind: 'text' | 'file';
}

const SELECT = `SELECT m.*, d.space_id, sp.slug AS space_slug, d.path, d.path_key, d.title, d.head_rev, d.content_hash, d.kind AS doc_kind,
    s.name AS sender_name, r.name AS recipient_name, x.name AS resolver_name,
    s.external AS sender_external, s.owner_label AS sender_owner_label, r.external AS recipient_external
  FROM handoff_messages m
  JOIN documents d ON d.id = m.doc_id
  JOIN spaces sp ON sp.id = d.space_id
  JOIN principals s ON s.id = m.sender_id
  JOIN principals r ON r.id = m.recipient_id
  LEFT JOIN principals x ON x.id = m.resolved_by`;

/**
 * Inbox spaces of the caller: the visible ones, plus those where it is a message-only member (Guest, or
 * an external, which never see an inbox space as such) with an explicit grant. Sorted by slug.
 */
export function inboxSpacesOf(ctx: AccessContext): SpaceRow[] {
  const visible = visibleSpaces(ctx)
    .filter((v) => isInboxSpace(v.space))
    .map((v) => v.space);
  const guest = ctx.disabled
    ? []
    : ctx.snapshot.spaces.filter((s) => isMessageOnly(ctx, s) && s.archived_at === null && hasExplicitGrant(ctx, s, ctx.principal.id));
  return [...visible, ...guest].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The caller's inbox spaces where it is a message-only member (Guest / external). */
export function guestSpacesOf(ctx: AccessContext): SpaceRow[] {
  return inboxSpacesOf(ctx).filter((s) => isMessageOnly(ctx, s));
}

/** Ids of the caller's inbox spaces; with `only`, just that one (if it is among them). */
export function inboxSpaceIds(ctx: AccessContext, only?: string): string[] {
  return inboxSpacesOf(ctx)
    .filter((s) => only === undefined || s.id === only)
    .map((s) => s.id);
}

/**
 * Live messages matching `where` in inbox spaces the caller can see, then the guard on every row.
 * Messages in spaces that are not (or no longer) inbox spaces are never listed.
 */
function visible(ctx: AccessContext, where: string, params: unknown[], order = 'm.changed_at DESC, m.doc_id DESC', spaceId?: string): MessageListRow[] {
  const ids = inboxSpaceIds(ctx, spaceId);
  if (ids.length === 0) return [];
  const rows = ctx.core.db
    .prepare(
      `${SELECT} WHERE m.tenant_id = ? AND d.deleted_at IS NULL AND d.space_id IN (${ids.map(() => '?').join(', ')}) AND (${where}) ORDER BY ${order}`,
    )
    .all(ctx.core.tenantId, ...ids, ...params) as MessageListRow[];
  return rows.filter((r) => {
    const space = ctx.snapshot.spaceById.get(r.space_id);
    return space !== undefined && atLeast(roleAt(ctx, space, r.path_key, r.doc_id), 'read');
  });
}

const WAITING_SQL = '(m.received_rev IS NULL OR m.received_rev < m.content_rev)';
const RESOLVED_SQL = '(m.resolution IS NOT NULL AND m.resolved_rev >= m.content_rev)';

export type Box = 'in' | 'out' | 'all';

/** Messages of a box: open ones (and done/declined with `includeDone`). */
export function boxMessages(ctx: AccessContext, box: Box, includeDone: boolean, since?: number, spaceId?: string): MessageListRow[] {
  const me = ctx.principal.id;
  const who = box === 'in' ? 'm.recipient_id = ?' : box === 'out' ? 'm.sender_id = ?' : '1 = 1';
  const params: unknown[] = box === 'all' ? [] : [me];
  let filter = '1 = 1';
  if (!includeDone) {
    // Outbox: unseen answers stay listed until the sender has seen them once.
    filter = since !== undefined ? `NOT ${RESOLVED_SQL} OR m.resolved_at > ?` : `NOT ${RESOLVED_SQL}`;
    if (since !== undefined) params.push(since);
  }
  return visible(ctx, `${who} AND (${filter})`, params, undefined, spaceId);
}

export function threadMessages(ctx: AccessContext, threadId: string): MessageListRow[] {
  return visible(ctx, 'm.thread_id = ?', [threadId], 'm.created_at, m.doc_id');
}

export function visibleMessage(ctx: AccessContext, docId: string): MessageListRow | undefined {
  return visible(ctx, 'm.doc_id = ?', [docId])[0];
}

/** The messages among `docIds` the caller can see now (same filter as every list), by id. */
export function visibleMessages(ctx: AccessContext, docIds: readonly string[]): Map<string, MessageListRow> {
  const out = new Map<string, MessageListRow>();
  const ids = [...new Set(docIds)];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    for (const r of visible(ctx, `m.doc_id IN (${part.map(() => '?').join(', ')})`, part)) out.set(r.doc_id, r);
  }
  return out;
}

/** Waiting messages to the caller, newest first (all inbox spaces, or one). */
export function waitingFor(ctx: AccessContext, spaceId?: string): MessageListRow[] {
  return visible(ctx, `m.recipient_id = ? AND ${WAITING_SQL}`, [ctx.principal.id], undefined, spaceId);
}

export function getOutboxSeen(db: Db, principalId: string): number {
  const row = db.prepare('SELECT outbox_seen_at AS t FROM principals WHERE id = ?').get(principalId) as { t: number | null } | undefined;
  return row?.t ?? 0;
}

export function setOutboxSeen(db: Db, principalId: string, at: number): void {
  db.prepare('UPDATE principals SET outbox_seen_at = ? WHERE id = ?').run(at, principalId);
}

/** Caller's messages answered (done/declined) since their last handoff_inbox(box="out"). */
export function answeredFor(ctx: AccessContext, spaceId?: string): MessageListRow[] {
  const since = getOutboxSeen(ctx.core.db, ctx.principal.id);
  return visible(ctx, `m.sender_id = ? AND ${RESOLVED_SQL} AND m.resolved_at > ?`, [ctx.principal.id, since], 'm.resolved_at DESC, m.doc_id DESC', spaceId);
}

/** Last time the principal used Brain (token use, start_here, UI session); null if never. */
export function lastSeen(db: Db, principalId: string): number | null {
  const row = db
    .prepare(
      `SELECT max(COALESCE((SELECT max(last_used_at) FROM tokens WHERE principal_id = @id), 0),
                  COALESCE((SELECT last_start_here_at FROM principals WHERE id = @id), 0),
                  COALESCE((SELECT max(last_seen_at) FROM sessions WHERE principal_id = @id), 0)) AS t`,
    )
    .get({ id: principalId }) as { t: number };
  return row.t > 0 ? row.t : null;
}

// --- Views and text ------------------------------------------------------------------------------------

export interface MessageOut {
  id: string;
  space: string;
  /** The canonical space of the message (an old inbox slug resolves to it). */
  canonical_space: string;
  path: string;
  title: string;
  from: string;
  to: string;
  /** Sender / recipient is an external principal. */
  from_external: boolean;
  to_external: boolean;
  status: MessageStatus;
  /** Head revision: pass it as expected_rev to handoff_ack. */
  rev: number;
  /** Last revision that changed the body. */
  content_rev: number;
  thread_id: string;
  reply_to: string | null;
  created_at: string;
  changed_at: string;
  /** Time since changed_at ("10m"). */
  age: string;
  received_rev: number | null;
  received_at: string | null;
  resolution: 'done' | 'declined' | null;
  resolved_at: string | null;
  resolved_by: string | null;
  note: string | null;
  /** The start of the body (heading left out), at most SNIPPET_MAX characters, one line. */
  snippet: string;
}

export const SNIPPET_MAX = 140;

/** One line from the start of a message body: the `# title` heading is skipped. */
export function snippetOf(text: string | undefined): string {
  if (text === undefined) return '';
  const body = text.replace(/^\uFEFF?#[^\n]*\n/, '');
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1)}…` : line;
}

const isoOrNull = (t: number | null): string | null => (t === null ? null : iso(t));

export function messageOut(ctx: AccessContext, r: MessageListRow): MessageOut {
  return {
    id: r.doc_id,
    space: r.space_slug,
    canonical_space: r.space_slug,
    path: r.path,
    title: r.title,
    from: r.sender_name,
    to: r.recipient_name,
    from_external: r.sender_external === 1,
    to_external: r.recipient_external === 1,
    status: statusOf(r),
    rev: r.head_rev,
    content_rev: r.content_rev,
    thread_id: r.thread_id,
    reply_to: r.reply_to,
    created_at: iso(r.created_at),
    changed_at: iso(r.changed_at),
    age: span(ctx.core.now() - r.changed_at),
    received_rev: r.received_rev,
    received_at: isoOrNull(r.received_at),
    resolution: r.resolution,
    resolved_at: isoOrNull(r.resolved_at),
    resolved_by: r.resolver_name,
    note: r.note,
    snippet: r.doc_kind === 'text' ? snippetOf(readTextBlob(ctx.core, r.content_hash)) : '',
  };
}

/** "5m", "2h", "3d"; under a minute "0m". */
export function span(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const ago = (ms: number): string => (ms < 60_000 ? 'just now' : `${span(ms)} ago`);

const q = (s: string): string => JSON.stringify(s.replace(/\s+/g, ' ').trim().slice(0, 120));
/** " in <space>" for messages outside the default space `handoff` (its texts stay as before). */
export const inSpace = (slug: string): string => (slug === HANDOFF_SPACE ? '' : ` in ${slug}`);

/** One hint line while the caller has messages not received at their current content. */
export function inboxHintLine(waiting: readonly MessageListRow[]): string | undefined {
  const newest = waiting[0];
  if (!newest) return undefined;
  // The title of external mail is attacker text: never in a line that rides on every tool result.
  if (newest.sender_external === 1) {
    const lead = waiting.length === 1 ? '1 waiting' : `${waiting.length} waiting, newest`;
    return `Inbox: ${lead} from external agent ${newest.sender_name} (${newest.space_slug}). Call handoff_inbox.`;
  }
  const lead = waiting.length === 1 ? '1 waiting —' : `${waiting.length} waiting — newest`;
  return `Inbox: ${lead} ${q(newest.title)} from ${newest.sender_name}${inSpace(newest.space_slug)}. Call handoff_inbox.`;
}

/** Title of a message for a hint, poll or wait result: null when the sender is external. */
export const hintTitle = (r: Pick<MessageListRow, 'title' | 'sender_external'>): string | null => (r.sender_external === 1 ? null : r.title);

/** One hint line for the sender while answers are unseen. */
export function outboxHintLine(answered: readonly MessageListRow[]): string | undefined {
  const newest = answered[0];
  if (!newest) return undefined;
  const by = newest.resolver_name ?? newest.recipient_name;
  const lead = answered.length === 1 ? '1 answered —' : `${answered.length} answered — newest`;
  return `Outbox: ${lead} ${q(newest.title)} ${newest.resolution} by ${by}${inSpace(newest.space_slug)}. Call handoff_inbox(box="out").`;
}

/** Statuses counted for a list. */
export function countStatuses(rows: readonly { status: MessageStatus }[]): Record<MessageStatus, number> {
  const c: Record<MessageStatus, number> = { new: 0, updated: 0, received: 0, done: 0, declined: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

/** Order of a list: waiting first, then received, then done/declined; newest change first inside. */
export function byStatus<T extends { status: MessageStatus }>(rows: T[]): T[] {
  const rank: Record<MessageStatus, number> = { new: 0, updated: 0, received: 1, done: 2, declined: 2 };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank[a.r.status] - rank[b.r.status] || a.i - b.i).map((x) => x.r);
}

// --- Poll (GET /api/v1/inbox) ----------------------------------------------------------------------------

export interface InboxPoll {
  /** Messages to the caller not received at their current content. */
  waiting: number;
  /** `title` is null for mail from an external principal (attacker text); `external` marks it. */
  newest: { id: string; space: string; from: string; title: string | null; external: boolean; sent_at: string } | null;
  /** The caller's messages done/declined since their last handoff_inbox(box="out"). */
  answered: number;
  /** Server clock (ISO), for watchers that keep a deadline. */
  server_time: string;
}

/**
 * "Do I have mail?" for a cron job: envelope rows and document metadata only, no
 * bodies, nothing changes. The same visibility as the hints: inbox spaces the caller can see, guard
 * on every row.
 */
export function pollInbox(ctx: AccessContext): InboxPoll {
  const waiting = waitingFor(ctx);
  const n = waiting[0];
  return {
    waiting: waiting.length,
    newest: n ? { id: n.doc_id, space: n.space_slug, from: n.sender_name, title: hintTitle(n), external: n.sender_external === 1, sent_at: iso(n.created_at) } : null,
    answered: answeredFor(ctx).length,
    server_time: iso(ctx.core.now()),
  };
}
