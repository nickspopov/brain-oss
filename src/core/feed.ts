// Change feed: `changes` with a server-side cursor per principal, and `activity` (reverse order, does
// not touch the cursor). Permissions follow the document's current location, in SQL before the limit,
// then guard.filterDocs/filterRevisions. `seen_rev` and `doc_seen` were removed.
import { getPrincipalById } from '../store/principals.js';
import { getCursorSeq, setCursorSeq } from '../store/cursors.js';
import { maxSeq } from '../store/revisions.js';
import { openCursor, sealCursor } from './cursor.js';
import { revInfo, type RevInfoOut } from './docview.js';
import { findPrincipal } from './principals.js';
import { feed, visibleSpaceIdsBySlug, type AccessContext, type FeedRow } from './guard.js';

export interface ChangeItem extends RevInfoOut {
  doc: { id: string; space: string; path: string; title: string };
}

function itemOf(ctx: AccessContext, r: FeedRow): ChangeItem {
  return {
    doc: { id: r.doc_id, space: ctx.snapshot.spaceById.get(r.doc_space_id)?.slug ?? '', path: r.doc_path, title: r.doc_title },
    ...revInfo(r),
  };
}

export interface ChangesInput {
  since?: string | undefined;
  spaces?: string[] | undefined;
  includeOwn: boolean;
  attentionOnly: boolean;
  limit: number;
}

/**
 * `changes`: without `since`, changes after the saved cursor (the cursor does not move);
 * with `since`, the cursor is saved and changes after it are returned. `cursor` in the response is the
 * position of the last **examined** row: with `has_more = false` it is the end of the log, so hidden
 * events behind it do not hold the agent back.
 */
export function changes(ctx: AccessContext, input: ChangesInput): { changes: ChangeItem[]; cursor: string; has_more: boolean } {
  const db = ctx.core.db;
  let after: number;
  if (input.since !== undefined) {
    after = openCursor(ctx, 'changes', input.since);
    setCursorSeq(db, ctx.principal.id, after, ctx.core.now());
  } else {
    after = getCursorSeq(db, ctx.principal.id) ?? getPrincipalById(db, ctx.principal.id)?.start_seq ?? 0;
  }
  const spaceIds = input.spaces ? visibleSpaceIdsBySlug(ctx, input.spaces) : undefined;
  const rows = feed(ctx, {
    afterSeq: after,
    order: 'asc',
    spaceIds,
    ...(input.includeOwn ? {} : { excludeAuthor: ctx.principal.id }),
    attentionOnly: input.attentionOnly,
    limit: input.limit + 1,
  });
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const position = hasMore && last ? last.seq : Math.max(after, maxSeq(db));
  return { changes: page.map((r) => itemOf(ctx, r)), cursor: sealCursor(ctx, 'changes', position), has_more: hasMore };
}

export interface ActivityInput {
  space?: string | undefined;
  author?: string | undefined;
  before?: string | undefined;
  /** Messages are left out unless asked for (they live in the Inbox). */
  includeMessages?: boolean | undefined;
  limit: number;
}

/** `activity`: the same feed, newest first, with filters; does not touch the server-side cursor. */
export function activity(ctx: AccessContext, input: ActivityInput): { items: ChangeItem[]; next_cursor?: string } {
  const params = { s: input.space ?? null, a: input.author ?? null, ...(input.includeMessages ? { m: 1 } : {}) };
  const before = input.before !== undefined ? openCursor(ctx, 'activity', input.before, params) : undefined;
  const spaceIds = input.space !== undefined ? visibleSpaceIdsBySlug(ctx, [input.space]) : undefined;
  let authorId: string | undefined;
  if (input.author !== undefined) {
    const p = findPrincipal(ctx.core, input.author);
    // An unknown author gives an empty result, same as an author with no visible edits.
    if (!p) return { items: [] };
    authorId = p.id;
  }
  const rows = feed(ctx, {
    ...(before !== undefined ? { beforeSeq: before } : {}),
    order: 'desc',
    spaceIds,
    ...(authorId !== undefined ? { author: authorId } : {}),
    excludeMessages: input.includeMessages !== true,
    limit: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => itemOf(ctx, r)),
    ...(rows.length > input.limit && last ? { next_cursor: sealCursor(ctx, 'activity', last.seq, params) } : {}),
  };
}
