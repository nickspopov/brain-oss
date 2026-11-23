// Revisions: an immutable log. Insert and read only; UPDATE is blocked by a trigger
// (except purged_*).
import type { Db } from '../db/open.js';
import type { Kind, Trust } from './types.js';

export type RevisionKind = 'create' | 'update' | 'move' | 'delete' | 'restore' | 'revert' | 'undo' | 'expire' | 'import';
export type RevisionVia = 'mcp' | 'mcpl' | 'rest' | 'ui' | 'cli' | 'import' | 'system';

export interface RevisionRow {
  seq: number;
  doc_id: string;
  rev: number;
  kind: RevisionKind;
  space_id: string;
  path: string;
  prev_space_id: string | null;
  prev_path: string | null;
  content_hash: string;
  size: number;
  author_id: string;
  author_trust: Trust;
  approved_by: string | null;
  proposal_id: string | null;
  via: RevisionVia;
  message: string;
  ref_rev: number | null;
  attention: 0 | 1;
  created_at: number;
  purged_at: number | null;
  purged_by: string | null;
}

export interface RevisionView extends RevisionRow {
  author_name: string;
  author_kind: Kind;
  approver_name: string | null;
  approver_kind: Kind | null;
  approver_trust: Trust | null;
}

const VIEW = `
  SELECT r.*, a.name AS author_name, a.kind AS author_kind,
         ap.name AS approver_name, ap.kind AS approver_kind, ap.trust AS approver_trust
  FROM revisions r
  JOIN principals a ON a.id = r.author_id
  LEFT JOIN principals ap ON ap.id = r.approved_by`;

export type RevisionInsert = Omit<RevisionRow, 'seq' | 'purged_at' | 'purged_by'>;

/** Inserts a revision and returns its global `seq`. */
export function insertRevision(db: Db, row: RevisionInsert): number {
  const info = db
    .prepare(
      `INSERT INTO revisions (doc_id, rev, kind, space_id, path, prev_space_id, prev_path, content_hash, size,
         author_id, author_trust, approved_by, proposal_id, via, message, ref_rev, attention, created_at)
       VALUES (@doc_id, @rev, @kind, @space_id, @path, @prev_space_id, @prev_path, @content_hash, @size,
         @author_id, @author_trust, @approved_by, @proposal_id, @via, @message, @ref_rev, @attention, @created_at)`,
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

export function getRevisionView(db: Db, docId: string, rev: number): RevisionView | undefined {
  return db.prepare(`${VIEW} WHERE r.doc_id = ? AND r.rev = ?`).get(docId, rev) as RevisionView | undefined;
}

/** Revisions of a document, newest first, with a number below `beforeRev`. */
export function listRevisionViews(db: Db, docId: string, beforeRev: number, limit: number): RevisionView[] {
  return db
    .prepare(`${VIEW} WHERE r.doc_id = ? AND r.rev < ? ORDER BY r.rev DESC LIMIT ?`)
    .all(docId, beforeRev, limit) as RevisionView[];
}

/** Lowest trust level among authors of body-changing revisions (for trust_floor). */
export function bodyAuthorsTrust(db: Db, docId: string): Trust[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT author_trust FROM revisions
         WHERE doc_id = ? AND kind IN ('create', 'update', 'revert', 'undo', 'import')`,
      )
      .all(docId) as { author_trust: Trust }[]
  ).map((r) => r.author_trust);
}

// --- Feed: changes and activity -----------------------------------------------------------------

/** A revision with the document's current location (permissions are computed against it). */
export interface FeedRow extends RevisionView {
  doc_space_id: string;
  doc_path: string;
  doc_path_key: string;
  doc_title: string;
}

export interface FeedQuery {
  /** Permission condition on document `d` (built by guard). */
  filter: { sql: string; params: (string | number)[] };
  afterSeq?: number;
  beforeSeq?: number;
  order: 'asc' | 'desc';
  spaceIds?: readonly string[];
  excludeAuthor?: string;
  author?: string;
  attentionOnly?: boolean;
  /** Leave out revisions of messages (they live in the Inbox). */
  excludeMessages?: boolean;
  limit: number;
}

export function feedRows(db: Db, q: FeedQuery): FeedRow[] {
  const where: string[] = [`(${q.filter.sql})`];
  const params: (string | number)[] = [...q.filter.params];
  if (q.afterSeq !== undefined) {
    where.push('r.seq > ?');
    params.push(q.afterSeq);
  }
  if (q.beforeSeq !== undefined) {
    where.push('r.seq < ?');
    params.push(q.beforeSeq);
  }
  if (q.spaceIds) {
    if (q.spaceIds.length === 0) return [];
    where.push(`d.space_id IN (${q.spaceIds.map(() => '?').join(', ')})`);
    params.push(...q.spaceIds);
  }
  if (q.excludeAuthor !== undefined) {
    where.push('r.author_id != ?');
    params.push(q.excludeAuthor);
  }
  if (q.author !== undefined) {
    where.push('r.author_id = ?');
    params.push(q.author);
  }
  if (q.attentionOnly) where.push('r.attention = 1');
  if (q.excludeMessages) where.push('NOT EXISTS (SELECT 1 FROM handoff_messages hm WHERE hm.doc_id = r.doc_id)');
  params.push(q.limit);
  return db
    .prepare(
      `SELECT r.*, a.name AS author_name, a.kind AS author_kind,
              ap.name AS approver_name, ap.kind AS approver_kind, ap.trust AS approver_trust,
              d.space_id AS doc_space_id, d.path AS doc_path, d.path_key AS doc_path_key, d.title AS doc_title
       FROM revisions r
       JOIN documents d ON d.id = r.doc_id
       JOIN principals a ON a.id = r.author_id
       LEFT JOIN principals ap ON ap.id = r.approved_by
       WHERE ${where.join(' AND ')}
       ORDER BY r.seq ${q.order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT ?`,
    )
    .all(...params) as FeedRow[];
}

/** Latest `seq` of the log (0 if there are no revisions). */
export function maxSeq(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM revisions').get() as { s: number }).s;
}

/** Purges a revision body: only `purged_*` change (the immutability trigger allows this). */
export function markRevisionPurged(db: Db, docId: string, rev: number, at: number, by: string): void {
  db.prepare('UPDATE revisions SET purged_at = ?, purged_by = ? WHERE doc_id = ? AND rev = ? AND purged_at IS NULL').run(at, by, docId, rev);
}

/** Whether a non-purged revision or a proposal uses this body. */
export function bodyStillReferenced(db: Db, hash: string): boolean {
  const r = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM revisions WHERE content_hash = ? AND purged_at IS NULL)
           OR EXISTS (SELECT 1 FROM proposals WHERE content_hash = ?) AS used`,
    )
    .get(hash, hash) as { used: number };
  return r.used === 1;
}
