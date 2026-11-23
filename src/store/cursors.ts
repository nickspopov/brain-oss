// Server-side `changes` cursor per principal.
import type { Db } from '../db/open.js';

export function getCursorSeq(db: Db, principalId: string): number | undefined {
  return (db.prepare('SELECT seq FROM cursors WHERE principal_id = ?').get(principalId) as { seq: number } | undefined)?.seq;
}

export function setCursorSeq(db: Db, principalId: string, seq: number, now: number): void {
  db.prepare(
    `INSERT INTO cursors (principal_id, seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(principal_id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`,
  ).run(principalId, seq, now);
}
