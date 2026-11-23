// Sizes for quotas: space usage, history, the whole DB.
import type { Db } from '../db/open.js';

/** Current `bytes_used` of a space (the permission snapshot may be stale). */
export function spaceBytesUsed(db: Db, spaceId: string): number {
  const r = db.prepare('SELECT bytes_used FROM spaces WHERE id = ?').get(spaceId) as { bytes_used: number } | undefined;
  return r?.bytes_used ?? 0;
}

/** Total size of the space's body-changing revisions (a rough history quota). */
export function spaceHistoryBytes(db: Db, spaceId: string): number {
  const r = db
    .prepare(
      `SELECT coalesce(sum(size), 0) AS n FROM revisions
       WHERE space_id = ? AND kind IN ('create', 'update', 'revert', 'undo', 'import') AND purged_at IS NULL`,
    )
    .get(spaceId) as { n: number };
  return r.n;
}

/**
 * Bytes of the pages of the audit table and its indexes. Walks the tree pages via dbstat: the caller
 * caches the result rather than calling this on every write.
 */
export function auditBytes(db: Db): number {
  const r = db
    .prepare(
      `SELECT coalesce(sum(pgsize), 0) AS n FROM dbstat('main', 1)
       WHERE name IN (SELECT name FROM sqlite_schema WHERE tbl_name = 'audit')`,
    )
    .get() as { n: number };
  return r.n;
}

/**
 * Bytes of used DB pages (excluding the freelist) plus file blobs on disk. `excludeBytes` is the
 * amount that does not count toward the data limit (the audit log).
 */
export function dataBytes(db: Db, excludeBytes = 0): number {
  // Pragma table functions via prepare (cached in db/open); db.pragma() prepares the statement anew
  // on every call, and here that would be every write.
  const { pages, pageSize } = db
    .prepare(
      'SELECT p.page_count - f.freelist_count AS pages, s.page_size AS pageSize FROM pragma_page_count() p, pragma_freelist_count() f, pragma_page_size() s',
    )
    .get() as { pages: number; pageSize: number };
  const files = db.prepare("SELECT coalesce(sum(size), 0) AS n FROM blobs WHERE storage = 'file'").get() as { n: number };
  return Math.max(0, pages * pageSize - excludeBytes) + files.n;
}
