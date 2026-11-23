// Mail-event cursors: client-held cursors over the durable
// mail-event history. Level-triggered "waiting" stays the source of truth; a cursor only answers "what
// changed for me since I last dispatched a wake". Nothing here writes: the client owns its cursor, so
// two listeners never consume each other's events and a lost response is replayed with the old cursor.
//
// The cursor is sealed (core/cursor.ts): bound to the principal and the event filter, random nonce,
// fixed width, so it exposes no global sequence. Every event goes through current access (inbox spaces,
// guard, mail predicate) when it is read, so revocation before a replay hides it. A cursor that cannot
// be opened (garbage, foreign, other filter), is below the pruned floor or beyond the head (restored
// database) gets an explicit `resync` with the level snapshot — never an empty success.
import { mailEventsAfter, mailEventsFloor, mailEventsHead, type MailEventKind } from '../store/mailevents.js';
import { openCursor, sealCursor } from './cursor.js';
import type { AccessContext } from './guard.js';
import { answeredFor, statusOf, visibleMessages, waitingFor } from './inbox.js';

export type { MailEventKind } from '../store/mailevents.js';
export type EventsFilter = 'inbox' | 'answers' | 'both';
export const EVENTS_FILTERS: readonly EventsFilter[] = ['inbox', 'answers', 'both'];
export const EVENT_KINDS: Record<EventsFilter, readonly MailEventKind[]> = {
  inbox: ['inbound', 'updated'],
  answers: ['answered'],
  both: ['inbound', 'updated', 'answered'],
};
/** Events in one response; `more: true` when the next page is not empty. */
export const EVENTS_PAGE = 100;
/** Longest `since` accepted as a cursor; anything longer is garbage (resync). */
export const CURSOR_MAX = 512;
const SCAN_BATCH = 500;
const CURSOR_KIND = 'mail';

export interface MailEventOut {
  id: string;
  rev: number;
  kind: MailEventKind;
  space: string;
}

export interface MailEventsPage {
  events: MailEventOut[];
  next_cursor: string;
  more?: true;
  resync?: true;
}

const seal = (ctx: AccessContext, filter: EventsFilter, value: number): string => sealCursor(ctx, CURSOR_KIND, value, { events: filter });

/** Cursor at the current head: what a consistent level snapshot taken now has already covered. */
export function headCursor(ctx: AccessContext, filter: EventsFilter): string {
  return seal(ctx, filter, mailEventsHead(ctx.core.db));
}

/** The position in a cursor, or undefined when the caller must resynchronise. */
export function openMailCursor(ctx: AccessContext, filter: EventsFilter, cursor: string): number | undefined {
  if (cursor.length === 0 || cursor.length > CURSOR_MAX) return undefined;
  let v: number;
  try {
    v = openCursor(ctx, CURSOR_KIND, cursor, { events: filter });
  } catch {
    return undefined;
  }
  const db = ctx.core.db;
  if (v < mailEventsFloor(db) || v > mailEventsHead(db)) return undefined;
  return v;
}

/** Actionable mail now, as events (the level snapshot of a resync). */
export function snapshotEvents(ctx: AccessContext, filter: EventsFilter): MailEventOut[] {
  const kinds = EVENT_KINDS[filter];
  const out: MailEventOut[] = [];
  if (kinds.includes('inbound')) {
    for (const r of waitingFor(ctx)) out.push({ id: r.doc_id, rev: r.head_rev, kind: statusOf(r) === 'new' ? 'inbound' : 'updated', space: r.space_slug });
  }
  if (kinds.includes('answered')) {
    for (const r of answeredFor(ctx)) out.push({ id: r.doc_id, rev: r.head_rev, kind: 'answered', space: r.space_slug });
  }
  return out;
}

/**
 * Visible events after position `after`: at most `limit`, plus the position to continue from. Hidden
 * events (revoked access, deleted messages) are skipped silently; the position moves past them, which
 * reveals nothing because the cursor is sealed.
 */
export function eventsAfter(ctx: AccessContext, filter: EventsFilter, after: number, limit = EVENTS_PAGE): { events: MailEventOut[]; next: number; more: boolean } {
  const db = ctx.core.db;
  const me = ctx.principal.id;
  const head = mailEventsHead(db);
  const events: MailEventOut[] = [];
  let pos = after;
  for (;;) {
    const rows = mailEventsAfter(db, ctx.core.tenantId, me, pos, EVENT_KINDS[filter], SCAN_BATCH);
    const seen = visibleMessages(
      ctx,
      rows.map((r) => r.doc_id),
    );
    for (const r of rows) {
      const m = seen.get(r.doc_id);
      const mine = m !== undefined && (r.kind === 'answered' ? m.sender_id === me : m.recipient_id === me);
      if (!mine) {
        pos = r.seq;
        continue;
      }
      // One more visible event than the page: the page is full and there is more.
      if (events.length === limit) return { events, next: pos, more: true };
      events.push({ id: r.doc_id, rev: r.rev, kind: r.kind, space: m.space_slug });
      pos = r.seq;
    }
    if (rows.length < SCAN_BATCH) break;
  }
  // Nothing more of mine up to the head: continue from the head.
  return { events, next: Math.max(pos, head), more: false };
}

/** One poll with `since`: the events after the cursor, or an explicit resync with the level snapshot. */
export function pollSince(ctx: AccessContext, filter: EventsFilter, since: string): MailEventsPage {
  const after = openMailCursor(ctx, filter, since);
  if (after === undefined) return { events: snapshotEvents(ctx, filter), next_cursor: headCursor(ctx, filter), resync: true };
  const page = eventsAfter(ctx, filter, after);
  return { events: page.events, next_cursor: seal(ctx, filter, page.next), ...(page.more ? { more: true as const } : {}) };
}

/** Wake condition of a parked cursor wait: a visible event after the cursor, or a cursor that needs resync. */
export function hasEventsSince(ctx: AccessContext, filter: EventsFilter, since: string): boolean {
  const after = openMailCursor(ctx, filter, since);
  return after === undefined || eventsAfter(ctx, filter, after, 1).events.length > 0;
}

/** Level check of a filter: waiting mail (inbox) and/or unseen answers (answers). */
export function levelMatches(waiting: number, answered: number, filter: EventsFilter): boolean {
  return (filter !== 'answers' && waiting > 0) || (filter !== 'inbox' && answered > 0);
}
