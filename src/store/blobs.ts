// Content-addressed bodies: `inline` is text in the row; `file` is bytes in data/blobs.
// SQL only here; files on disk are managed by core/blobs.ts.
import type { Db } from '../db/open.js';

export interface BlobRow {
  hash: string;
  storage: 'inline' | 'file';
  text: string | null;
  size: number;
  created_at: number;
}

export function getBlob(db: Db, hash: string): BlobRow | undefined {
  return db.prepare('SELECT * FROM blobs WHERE hash = ?').get(hash) as BlobRow | undefined;
}

/** Inserts if the hash is not there yet (identical bodies are not duplicated). */
export function insertBlobIfMissing(db: Db, row: BlobRow): void {
  db.prepare(
    `INSERT INTO blobs (hash, storage, text, size, created_at) VALUES (@hash, @storage, @text, @size, @created_at)
     ON CONFLICT(hash) DO NOTHING`,
  ).run(row);
}
