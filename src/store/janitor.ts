// Janitor housekeeping queries and cleanups, and final document purge:
// SQL only, no permissions.
import type { Db } from '../db/open.js';
import { deleteMailEventsForDoc } from './mailevents.js';

/** Live documents whose TTL has expired. */
export function expiredDocIds(db: Db, now: number, limit: number): string[] {
  return (
    db
      .prepare('SELECT id FROM documents WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL ORDER BY expires_at LIMIT ?')
      .all(now, limit) as { id: string }[]
  ).map((r) => r.id);
}

/** Deleted documents that have been in the trash longer than their space's `trash_retention_days`. */
export function trashDueDocIds(db: Db, now: number, limit: number): string[] {
  return (
    db
      .prepare(
        `SELECT d.id FROM documents d JOIN spaces s ON s.id = d.space_id
         WHERE d.deleted_at IS NOT NULL AND s.trash_retention_days IS NOT NULL
           AND d.deleted_at < ? - s.trash_retention_days * 86400000
         ORDER BY d.deleted_at LIMIT ?`,
      )
      .all(now, limit) as { id: string }[]
  ).map((r) => r.id);
}

export function deleteIdempotencyBefore(db: Db, before: number): number {
  return db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(before).changes;
}

export function deleteExpiredSessions(db: Db, now: number): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes;
}

/** Read audit rows older than `before` (writes and write denials are kept forever). */
export function deleteAuditReadsBefore(db: Db, before: number, readOps: readonly string[]): number {
  if (readOps.length === 0) return 0;
  return db
    .prepare(`DELETE FROM audit WHERE ts < ? AND op IN (${readOps.map(() => '?').join(',')})`)
    .run(before, ...readOps).changes;
}

/**
 * Denials that can be produced as a flood: failed authentication, rate limit, `not_found` (unknown
 * operation or address). Permission denials (`forbidden`) are part of the access history and stay.
 */
const STREAM_DENIAL_SQL = `(outcome IN ('unauthenticated', 'rate_limited', 'not_found') OR op = 'unknown')`;

/** Flood denials older than `before`. */
export function deleteAuditDenialsBefore(db: Db, before: number): number {
  return db.prepare(`DELETE FROM audit WHERE ts < ? AND ${STREAM_DENIAL_SQL}`).run(before).changes;
}

/**
 * Eviction when the audit cap is exceeded: up to `limit` oldest rows that are not writes, i.e.
 * flood denials and reads (writes are kept forever).
 */
export function evictAuditRows(db: Db, limit: number, readOps: readonly string[]): number {
  const reads = readOps.length ? ` OR op IN (${readOps.map(() => '?').join(',')})` : '';
  return db
    .prepare(`DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE ${STREAM_DENIAL_SQL}${reads} ORDER BY id LIMIT ?)`)
    .run(...readOps, limit).changes;
}

export interface ExportFileRow {
  id: string;
  file: string;
}

export function expiredExports(db: Db, now: number): ExportFileRow[] {
  return db.prepare('SELECT id, file FROM exports WHERE expires_at < ?').all(now) as ExportFileRow[];
}

export function deleteExport(db: Db, id: string): void {
  db.prepare('DELETE FROM exports WHERE id = ?').run(id);
}

export function blobExists(db: Db, hash: string): boolean {
  return db.prepare('SELECT 1 FROM blobs WHERE hash = ?').get(hash) !== undefined;
}

// --- Purging a whole document ---------------------------------------------------------------------

export interface PurgedDoc {
  num: number;
  space_id: string;
  /** Body hashes of the document's revisions and proposals: candidates for removal from blobs. */
  hashes: string[];
}

/**
 * Deletes a document and everything that refers to it: revisions, the Yjs body, client bindings,
 * "seen" marks, proposals, `scope = doc` grants, the FTS row, stored idempotency responses with its id.
 * Returns `undefined` if the document does not exist.
 */
export function deleteDocumentRows(db: Db, docId: string): PurgedDoc | undefined {
  const doc = db.prepare('SELECT num, space_id FROM documents WHERE id = ?').get(docId) as { num: number; space_id: string } | undefined;
  if (!doc) return undefined;
  const hashes = new Set<string>();
  for (const r of db.prepare('SELECT DISTINCT content_hash FROM revisions WHERE doc_id = ?').all(docId) as { content_hash: string }[]) {
    hashes.add(r.content_hash);
  }
  for (const r of db.prepare('SELECT DISTINCT content_hash FROM proposals WHERE doc_id = ?').all(docId) as { content_hash: string }[]) {
    hashes.add(r.content_hash);
  }
  db.prepare('DELETE FROM fts_docs WHERE rowid = ?').run(doc.num);
  db.prepare('DELETE FROM revisions WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM proposals WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM doc_ystate WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM yclients WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM doc_seen WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM handoff_messages WHERE doc_id = ?').run(docId);
  deleteMailEventsForDoc(db, docId);
  db.prepare("DELETE FROM grants WHERE scope = 'doc' AND doc_id = ?").run(docId);
  // A stored response that mentions the purged document is purged too.
  deleteIdempotencyForDoc(db, docId);
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  return { num: doc.num, space_id: doc.space_id, hashes: [...hashes] };
}

/** Hashes from the list that are no longer referenced by any revision or proposal. */
export function unreferencedHashes(db: Db, hashes: readonly string[]): string[] {
  const used = db.prepare(
    'SELECT EXISTS (SELECT 1 FROM revisions WHERE content_hash = ?) OR EXISTS (SELECT 1 FROM proposals WHERE content_hash = ?) AS used',
  );
  return hashes.filter((h) => (used.get(h, h) as { used: number }).used === 0);
}

/** Deletes a blobs row; returns its storage kind (to delete the file from disk). */
export function deleteBlob(db: Db, hash: string): 'inline' | 'file' | undefined {
  const row = db.prepare('SELECT storage FROM blobs WHERE hash = ?').get(hash) as { storage: 'inline' | 'file' } | undefined;
  if (!row) return undefined;
  db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash);
  return row.storage;
}

/** Stored idempotency responses that mention the document. */
export function deleteIdempotencyForDoc(db: Db, docId: string): number {
  return db.prepare('DELETE FROM idempotency WHERE instr(response, ?) > 0').run(`"${docId}"`).changes;
}
