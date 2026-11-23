// handoff_send and handoff_ack. Sending is an ordinary create through commit (grants,
// secret scan, quotas, audit); the commit hook registers the message. An ack changes only the
// envelope row and the document expiry; it is audited but is not a revision.
import { getLiveDocViewByPathKey, updateDocument } from '../store/documents.js';
import { recordAudit } from './audit.js';
import type { DocInfoOut } from './docview.js';
import { bodyText, inWriteTx, writeDocument, type WriteContext } from './documents.js';
import { conflict, invalidInput, notFound, OpError } from './errors.js';
import { recordMailEvent } from '../store/mailevents.js';
import { getPrincipalById } from '../store/principals.js';
import { EXTERNAL_TITLE_MAX, limitsOf, utcDayStart } from './external.js';
import { atLeast, isMessageOnly, isSuperadmin, requireDoc, revisionOf, roleAt, type AccessContext } from './guard.js';
import { AGENTS_DIR, closestName, HANDOFF_SPACE, isInboxSpace } from './handoff.js';
import {
  ago,
  getMessage,
  handoffRecipients,
  inboxSpacesOf,
  lastSeen,
  messageOut,
  recipientNamed,
  resolvedExpiry,
  setThread,
  statusOf,
  threadMessages,
  visibleMessage,
  type MessageOut,
  type MessageStatus,
  type Recipient,
} from './inbox.js';
import { pathKey } from './paths.js';
import type { SpaceRow } from '../store/types.js';
import { boundedPatch } from './textdiff.js';

export interface SendInput {
  to: string;
  title: string;
  body: string;
  replyTo?: string | undefined;
  /** Inbox space slug; see `sendSpace`. */
  space?: string | undefined;
}

export interface SendOut {
  message: MessageOut;
  doc: DocInfoOut;
  /** When the recipient last used Brain (ISO), null if never. */
  recipient_last_seen: string | null;
  /** The recipient is an external principal: the result warns the sender. */
  recipient_external?: { owner: string | null };
}

/** "No agent" error: suggestions only from valid recipients of the spaces given (the caller's own). */
function noRecipient(ctx: AccessContext, spaces: readonly SpaceRow[], raw: string): OpError {
  const names = [...new Set(spaces.flatMap((s) => handoffRecipients(ctx.core, s).map((p) => p.name)))];
  const match = closestName(names, raw.trim().toLowerCase());
  const see = spaces.find((s) => s.slug === HANDOFF_SPACE) ?? (spaces.length === 1 ? spaces[0] : undefined);
  return invalidInput(
    'to',
    `No agent "${raw.trim().slice(0, 63)}".${match !== undefined ? ` Did you mean ${match}?` : ''}${see !== undefined ? ` See ${see.slug}/${AGENTS_DIR}/.` : ''}`,
  );
}

/** Write context of a send into `<space>/<to>/`: a message-only member (Guest, external) may create exactly that message. */
function sendCtx<C extends AccessContext>(ctx: C, space: SpaceRow, to: string): C {
  return isMessageOnly(ctx, space) ? { ...ctx, inboxSend: { spaceId: space.id, folderKey: `${to.toLowerCase()}/` } } : ctx;
}

/** The caller can create a message to `to` in this space (write on the recipient folder). */
function canSendIn(ctx: AccessContext, space: SpaceRow, to: string): boolean {
  return atLeast(roleAt(sendCtx(ctx, space, to), space, `${to.toLowerCase()}/`), 'write');
}

/**
 * The inbox space of a send. A reply stays in the space of its parent (a
 * different `space` is an error). A given `space` must be one of the caller's inbox spaces; an unknown,
 * hidden or non-inbox slug gets one error and never falls back elsewhere. Otherwise: the unique inbox
 * space where the caller can write and `to` is a valid recipient; several → `handoff` if among them,
 * else an error listing only those. Errors name only the caller's own spaces and their recipients.
 */
function sendTarget(ctx: WriteContext, slug: string | undefined, parent: SpaceRow | undefined, rawTo: string): { space: SpaceRow; to: Recipient } {
  const mine = inboxSpacesOf(ctx);
  let space: SpaceRow;
  // An old (alias) slug names its canonical space.
  const named = slug !== undefined ? ctx.snapshot.spaceBySlug.get(slug) : undefined;
  if (parent) {
    if (slug !== undefined && named?.id !== parent.id) throw invalidInput('space', `A reply stays in the space of reply_to (${parent.slug}); omit space.`);
    space = parent;
  } else if (slug !== undefined) {
    const s = named ? mine.find((x) => x.id === named.id) : undefined;
    if (!s) throw invalidInput('space', 'No such inbox space.');
    space = s;
  } else {
    if (mine.length === 0) throw invalidInput('space', 'No inbox space you can write to.');
    const hits = mine.filter((s) => recipientNamed(ctx.core, s, rawTo) !== undefined);
    const writable = hits.filter((s) => canSendIn(ctx, s, rawTo.trim()));
    // Read-only where the recipient is: the write itself refuses (forbidden), as before.
    const pool = writable.length > 0 ? writable : hits;
    if (pool.length === 0) throw noRecipient(ctx, mine, rawTo);
    const dflt = pool.find((s) => s.slug === HANDOFF_SPACE);
    if (dflt) space = dflt;
    else if (pool.length === 1) space = pool[0]!;
    else throw invalidInput('space', `Specify space: one of ${pool.map((s) => s.slug).join(', ')}.`);
  }
  const to = recipientNamed(ctx.core, space, rawTo);
  if (!to) throw noRecipient(ctx, [space], rawTo);
  return { space, to };
}

export interface SendableRecipient {
  name: string;
  display_name: string;
  external: boolean;
  /** Name of the managing person (principal owner), if any. */
  manager: string | null;
  /** Free-text name of the person outside who runs an external agent. */
  owner_label: string | null;
  /** The caller's inbox spaces where a send to this recipient is accepted, by slug. */
  spaces: string[];
  /** Its profile line "what I do", if filled in. */
  what_i_do: string | null;
}

/**
 * Whom the caller can message (the To picker): exactly the recipients `sendTarget` accepts —
 * a valid recipient in one of the caller's own inbox spaces where the caller can write the recipient's
 * folder. Never another space's members, never disabled principals, never the caller.
 */
export function sendableRecipients(ctx: AccessContext): SendableRecipient[] {
  const out = new Map<string, SendableRecipient>();
  for (const space of inboxSpacesOf(ctx)) {
    // A superadmin still sees archived spaces; nobody is offered there.
    if (space.archived_at !== null) continue;
    for (const r of handoffRecipients(ctx.core, space)) {
      if (r.id === ctx.principal.id || !canSendIn(ctx, space, r.name)) continue;
      const hit = out.get(r.id);
      if (hit) {
        hit.spaces.push(space.slug);
        continue;
      }
      // A message-only member (Guest, external) sees only the minimal identity of whom it can message.
      const minimal = isMessageOnly(ctx, space);
      const manager = !minimal && r.owner_id ? (getPrincipalById(ctx.core.db, r.owner_id)?.name ?? null) : null;
      out.set(r.id, {
        name: r.name,
        display_name: r.display_name,
        external: r.external,
        manager,
        owner_label: minimal ? null : r.owner_label,
        spaces: [space.slug],
        // The reviewed profile line; a recipient is a co-member, so this reveals no one new.
        what_i_do: getPrincipalById(ctx.core.db, r.id)?.what_i_do ?? null,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Limits of an external sender: per-principal settings with defaults. */
function checkExternalSend(ctx: WriteContext, title: string, rawTitle: string, body: string, to: Recipient): void {
  if (ctx.principal.external !== true) return;
  const row = getPrincipalById(ctx.core.db, ctx.principal.id);
  if (!row) throw notFound();
  const lim = limitsOf(row);
  if (/[\r\n]/.test(rawTitle.trim()) || title.length > EXTERNAL_TITLE_MAX) {
    throw invalidInput('title', `One line, at most ${EXTERNAL_TITLE_MAX} characters.`);
  }
  if (lim.body_bytes !== null && Buffer.byteLength(body, 'utf8') > lim.body_bytes) {
    throw new OpError('too_large', { limit_bytes: lim.body_bytes }, `Message body is over ${lim.body_bytes} bytes.`);
  }
  const db = ctx.core.db;
  if (lim.msgs_per_day !== null) {
    const sent = (db.prepare('SELECT count(*) AS n FROM handoff_messages WHERE sender_id = ? AND created_at >= ?').get(row.id, utcDayStart(ctx.core.now())) as { n: number }).n;
    if (sent >= lim.msgs_per_day) {
      throw new OpError('quota_exceeded', { reason: 'messages_per_day', limit: lim.msgs_per_day }, `Daily limit reached: ${lim.msgs_per_day} messages per day. Try again tomorrow (UTC).`);
    }
  }
  if (lim.pending_per_recipient !== null) {
    const open = (
      db
        .prepare(
          `SELECT count(*) AS n FROM handoff_messages m JOIN documents d ON d.id = m.doc_id
           WHERE m.sender_id = ? AND m.recipient_id = ? AND d.deleted_at IS NULL
             AND NOT (m.resolution IS NOT NULL AND m.resolved_rev >= m.content_rev)`,
        )
        .get(row.id, to.id) as { n: number }
    ).n;
    if (open >= lim.pending_per_recipient) {
      throw new OpError(
        'quota_exceeded',
        { reason: 'pending_per_recipient', limit: lim.pending_per_recipient },
        `${to.name} has ${open} open messages from you (limit ${lim.pending_per_recipient}). Wait until they are done or declined.`,
      );
    }
  }
}

/** `yyyy-mm-dd-<slug of title>`: lowercase letters, digits and dashes, at most 60 characters. */
export function messageFileName(title: string, now: number): string {
  const slug =
    title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'message';
  return `${new Date(now).toISOString().slice(0, 10)}-${slug}`;
}

function freePath(ctx: WriteContext, spaceId: string, folder: string, base: string): string {
  for (let i = 1; i < 1000; i++) {
    const path = `${folder}/${base}${i === 1 ? '' : `-${i}`}.md`;
    if (!getLiveDocViewByPathKey(ctx.core.db, spaceId, pathKey(path))) return path;
  }
  throw conflict('path_taken');
}

export function messageContent(title: string, body: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  return `# ${t}\n\n${body.replace(/\s+$/, '')}\n`;
}

export function sendMessage(ctx: WriteContext, input: SendInput): SendOut {
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (title === '') throw invalidInput('title', 'Must not be empty.');
  return inWriteTx(ctx, () => {
    let parent: { space: SpaceRow; row: NonNullable<ReturnType<typeof getMessage>> } | undefined;
    if (input.replyTo !== undefined) {
      // A message the caller cannot read is "not found", exactly like an id that does not exist.
      const p = requireDoc(ctx, { id: input.replyTo }, 'read');
      const row = getMessage(ctx.core.db, p.doc.id);
      if (!row || !isInboxSpace(p.space)) throw invalidInput('reply_to', 'Not a handoff message.');
      parent = { space: p.space, row };
    }
    const { space, to } = sendTarget(ctx, input.space, parent?.space, input.to);
    checkExternalSend(ctx, title, input.title, input.body, to);
    let thread: { threadId: string; replyTo: string } | undefined;
    if (parent) {
      const row = parent.row;
      const pair = new Set([row.sender_id, row.recipient_id]);
      const want = new Set([ctx.principal.id, to.id]);
      if (pair.size !== want.size || ![...want].every((id) => pair.has(id))) {
        throw invalidInput('reply_to', `Must be a message between you and ${to.name}.`);
      }
      thread = { threadId: row.thread_id, replyTo: row.doc_id };
    }
    const wctx = sendCtx(ctx, space, to.name);
    const path = freePath(wctx, space.id, to.name, messageFileName(title, ctx.core.now()));
    const res = writeDocument(wctx, {
      space: space.slug,
      path,
      content: messageContent(title, input.body),
      expectedRev: 0,
      message: `Message to ${to.name}`,
    });
    // A message that needs review is not delivered: roll the proposal back and say so.
    if (res.status !== 'committed') {
      throw new OpError('conflict', { reason: 'review_required' }, `Your writes to ${space.slug} need review, so the message was not sent. Ask the space admin.`);
    }
    if (thread) setThread(ctx.core.db, res.doc.id, thread.threadId, thread.replyTo);
    const view = visibleMessage(wctx, res.doc.id);
    if (!view) throw new Error('sent message is not registered');
    const seen = lastSeen(ctx.core.db, to.id);
    return {
      message: messageOut(wctx, view),
      doc: res.doc,
      recipient_last_seen: seen === null ? null : new Date(seen).toISOString(),
      ...(to.external ? { recipient_external: { owner: to.owner_label } } : {}),
    };
  });
}

export type AckStatus = 'received' | 'done' | 'declined';

export interface AckInput {
  id: string;
  expectedRev: number;
  status: AckStatus;
  note?: string | undefined;
}

export interface AckOut {
  message: MessageOut;
  /** Nothing changed: the message already had this status. */
  already: boolean;
  /** For `already`: how long ago ("5m ago"). */
  since?: string;
}

const RANK: Record<MessageStatus, number> = { new: 0, updated: 0, received: 1, done: 2, declined: 2 };

/**
 * Only the recipient acks. The owner (human superadmin) may close any message as declined, so a
 * message to a disabled agent does not stay forever; that is audited as `owner_close`.
 */
export function ackMessage(ctx: WriteContext, input: AckInput): AckOut {
  const note = input.note?.trim() || undefined;
  if (input.status === 'declined' && note === undefined) throw invalidInput('note', 'Required for declined: say why.');
  return inWriteTx(ctx, () => {
    const access = requireDoc(ctx, { id: input.id }, 'read');
    const row = getMessage(ctx.core.db, access.doc.id);
    if (!row || !isInboxSpace(access.space)) throw invalidInput('id', 'Not a handoff message.');
    const recipient = row.recipient_id === ctx.principal.id;
    const ownerClose = !recipient && isSuperadmin(ctx) && input.status === 'declined';
    if (!recipient && !ownerClose) {
      const to = visibleMessage(ctx, row.doc_id)?.recipient_name ?? 'the recipient';
      throw new OpError('forbidden', { reason: 'not_recipient', recipient: to }, `Only the recipient (${to}) can ack this message.`);
    }
    const head = access.doc.head_rev;
    if (input.expectedRev !== head) {
      throw new OpError(
        'conflict',
        { reason: 'stale', expected_rev: input.expectedRev, head_rev: head },
        `Message changed: you passed rev ${input.expectedRev}, now rev ${head}. read("${row.doc_id}") first.`,
      );
    }
    const now = ctx.core.now();
    const status = statusOf(row);
    const done = (already: boolean, since?: number): AckOut => {
      const view = visibleMessage(ctx, row.doc_id);
      if (!view) throw notFound();
      if (!already) ctx.core.waiters.wake([row.sender_id, row.recipient_id]);
      recordAudit(ctx.core, {
        principal_id: ctx.principal.id,
        token_id: ctx.tokenId,
        via: ctx.via,
        op: ctx.op,
        outcome: 'ok',
        request_id: ctx.requestId,
        ip: ctx.ip,
        space_id: access.space.id,
        doc_id: row.doc_id,
        rev: head,
        detail: { status: input.status, ...(already ? { already: true } : {}), ...(ownerClose ? { owner_close: true } : {}) },
      });
      return { message: messageOut(ctx, view), already, ...(since !== undefined ? { since: ago(now - since) } : {}) };
    };
    if (input.status === 'received') {
      // Monotonic: received after done/declined at this content changes nothing.
      if (RANK[status] >= 1) return done(true, status === 'received' ? (row.received_at ?? now) : (row.resolved_at ?? now));
      ctx.core.db.prepare('UPDATE handoff_messages SET received_rev = ?, received_at = ? WHERE doc_id = ?').run(head, now, row.doc_id);
      return done(false);
    }
    if (status === input.status) return done(true, row.resolved_at ?? now);
    if (status === 'done' || status === 'declined') {
      throw new OpError('conflict', { reason: 'resolved', status }, `Already ${status}; a message is resolved once per revision.`);
    }
    const receivedNow = row.received_rev === null || row.received_rev < head;
    ctx.core.db
      .prepare(
        `UPDATE handoff_messages SET resolution = ?, resolved_rev = ?, resolved_at = ?, resolved_by = ?, note = ?,
           received_rev = ?, received_at = ? WHERE doc_id = ?`,
      )
      .run(input.status, head, now, ctx.principal.id, note ?? null, head, receivedNow ? now : row.received_at, row.doc_id);
    // The sender's answer event, in this transaction.
    recordMailEvent(ctx.core.db, { tenantId: row.tenant_id, principalId: row.sender_id, docId: row.doc_id, rev: head, kind: 'answered', now });
    // Resolved: the 14-day TTL starts now (pending messages never expire).
    updateDocument(ctx.core.db, row.doc_id, { expires_at: resolvedExpiry(access.space, now) });
    return done(false);
  });
}

// --- read on a message -------------------------------------------------------------------------------

export interface ReadContextOut {
  id: string;
  from: string;
  to: string;
  status: MessageStatus;
  rev: number;
  thread_id: string;
  reply_to: string | null;
  /** Other messages of the thread the caller can read, oldest first (at most 10). */
  thread: { id: string; title: string; from: string; to: string; status: MessageStatus }[];
  you: 'recipient' | 'sender' | 'other';
  received_rev: number | null;
  note: string | null;
  /** The sender is an external principal: `read` starts with the EXTERNAL header. */
  external_from?: { owner: string | null };
  /** Recipient only, when the body changed after they received it: the diff since received_rev. */
  changes?: { from_rev: number; to_rev: number; patch: string | null };
}

const THREAD_SHOWN = 10;

/** Message header for `read` (status, thread, diff since receipt); undefined for other documents. Changes nothing. */
export function readContext(ctx: AccessContext, docId: string, wantDiff: boolean): ReadContextOut | undefined {
  const m = visibleMessage(ctx, docId);
  if (!m) return undefined;
  const me = ctx.principal.id;
  const status = statusOf(m);
  const out: ReadContextOut = {
    id: m.doc_id,
    from: m.sender_name,
    to: m.recipient_name,
    status,
    rev: m.head_rev,
    thread_id: m.thread_id,
    reply_to: m.reply_to,
    thread: threadMessages(ctx, m.thread_id)
      .filter((t) => t.doc_id !== m.doc_id)
      .slice(-THREAD_SHOWN)
      .map((t) => ({ id: t.doc_id, title: t.title, from: t.sender_name, to: t.recipient_name, status: statusOf(t) })),
    you: m.recipient_id === me ? 'recipient' : m.sender_id === me ? 'sender' : 'other',
    received_rev: m.received_rev,
    note: m.note,
    ...(m.sender_external === 1 ? { external_from: { owner: m.sender_owner_label } } : {}),
  };
  if (wantDiff && out.you === 'recipient' && status === 'updated' && m.received_rev !== null) {
    const access = requireDoc(ctx, { id: docId }, 'read');
    if (access.doc.kind === 'text') {
      const from = revisionOf(ctx, access, m.received_rev);
      const a = from.purged_at === null ? bodyText(ctx, from.content_hash) : undefined;
      const b = bodyText(ctx, access.doc.content_hash);
      const patch = a !== undefined && b !== undefined ? (boundedPatch(access.doc.path, m.received_rev, access.doc.head_rev, a, b) ?? null) : null;
      out.changes = { from_rev: m.received_rev, to_rev: access.doc.head_rev, patch };
    }
  }
  return out;
}
