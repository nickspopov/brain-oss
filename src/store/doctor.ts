// Queries for `brain doctor`: read-only.
import type { Db } from '../db/open.js';

export function integrityCheck(db: Db): string[] {
  return (db.pragma('integrity_check') as { integrity_check: string }[]).map((r) => r.integrity_check);
}

export function foreignKeyViolations(db: Db): { table: string; rowid: number; parent: string }[] {
  return db.pragma('foreign_key_check') as { table: string; rowid: number; parent: string }[];
}

/** Documents whose revision numbers do not run 1..head_rev without gaps. */
export function revisionGaps(db: Db): { doc_id: string; head_rev: number; n: number; max_rev: number | null }[] {
  return db
    .prepare(
      `SELECT d.id AS doc_id, d.head_rev, count(r.rev) AS n, max(r.rev) AS max_rev
       FROM documents d LEFT JOIN revisions r ON r.doc_id = d.id
       GROUP BY d.id
       HAVING n != d.head_rev OR max_rev IS NOT d.head_rev`,
    )
    .all() as { doc_id: string; head_rev: number; n: number; max_rev: number | null }[];
}

/** Document heads whose hash does not match the hash of the head revision. */
export function headHashMismatches(db: Db): { doc_id: string }[] {
  return db
    .prepare(
      `SELECT d.id AS doc_id FROM documents d
       JOIN revisions r ON r.doc_id = d.id AND r.rev = d.head_rev
       WHERE r.content_hash != d.content_hash OR r.seq != d.head_seq`,
    )
    .all() as { doc_id: string }[];
}

/** Revision references to bodies missing from blobs (except purged ones). */
export function missingBlobs(db: Db): { doc_id: string; rev: number }[] {
  return db
    .prepare(
      `SELECT r.doc_id, r.rev FROM revisions r LEFT JOIN blobs b ON b.hash = r.content_hash
       WHERE b.hash IS NULL AND r.purged_at IS NULL`,
    )
    .all() as { doc_id: string; rev: number }[];
}

export interface InlineBlob {
  hash: string;
  text: string;
  size: number;
}

export function iterateInlineBlobs(db: Db): IterableIterator<InlineBlob> {
  return db.prepare("SELECT hash, text, size FROM blobs WHERE storage = 'inline'").iterate() as IterableIterator<InlineBlob>;
}

export function textDocsWithoutYState(db: Db): { doc_id: string }[] {
  return db
    .prepare(
      `SELECT d.id AS doc_id FROM documents d LEFT JOIN doc_ystate y ON y.doc_id = d.id
       WHERE d.kind = 'text' AND y.doc_id IS NULL`,
    )
    .all() as { doc_id: string }[];
}

export function tableCounts(db: Db, tables: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    if (!/^[a-z_]+$/.test(t)) throw new Error('bad table name');
    out[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}
