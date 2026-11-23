// Temporary export archives: one row per archive in data/tmp/exports.
import type { Db } from '../db/open.js';

export interface ExportRow {
  id: string;
  principal_id: string;
  space_id: string;
  /** File path relative to the data directory. */
  file: string;
  size: number;
  created_at: number;
  expires_at: number;
  mode: 'head' | 'full';
  /** JSON array of the ids of documents inside the archive. */
  doc_ids: string;
  sha256: string;
}

export function insertExport(db: Db, row: ExportRow): void {
  db.prepare(
    `INSERT INTO exports (id, principal_id, space_id, file, size, created_at, expires_at, mode, doc_ids, sha256)
     VALUES (@id, @principal_id, @space_id, @file, @size, @created_at, @expires_at, @mode, @doc_ids, @sha256)`,
  ).run(row);
}

export function getExport(db: Db, id: string): ExportRow | undefined {
  return db.prepare('SELECT * FROM exports WHERE id = ?').get(id) as ExportRow | undefined;
}

export function deleteExportRow(db: Db, id: string): void {
  db.prepare('DELETE FROM exports WHERE id = ?').run(id);
}

/** Archives of a space: on purge they are deleted entirely. */
export function exportsOfSpace(db: Db, spaceId: string): { id: string; file: string }[] {
  return db.prepare('SELECT id, file FROM exports WHERE space_id = ?').all(spaceId) as { id: string; file: string }[];
}
