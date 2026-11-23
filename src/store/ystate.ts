// Live Yjs body (doc_ystate): only for kind = text.
import type { Db } from '../db/open.js';

export interface YStateRow {
  doc_id: string;
  state: Buffer;
  head_rev: number;
}

export function getYState(db: Db, docId: string): YStateRow | undefined {
  return db.prepare('SELECT * FROM doc_ystate WHERE doc_id = ?').get(docId) as YStateRow | undefined;
}

export function putYState(db: Db, row: { doc_id: string; state: Uint8Array; head_rev: number }): void {
  db.prepare(
    `INSERT INTO doc_ystate (doc_id, state, head_rev) VALUES (@doc_id, @state, @head_rev)
     ON CONFLICT(doc_id) DO UPDATE SET state = excluded.state, head_rev = excluded.head_rev`,
  ).run({ doc_id: row.doc_id, state: Buffer.from(row.state), head_rev: row.head_rev });
}

export interface YStateCheckRow extends YStateRow {
  content_hash: string;
  kind: string;
  doc_head_rev: number;
}

export function iterateYStates(db: Db): IterableIterator<YStateCheckRow> {
  return db
    .prepare(
      `SELECT y.doc_id, y.state, y.head_rev, d.content_hash, d.kind, d.head_rev AS doc_head_rev
       FROM doc_ystate y JOIN documents d ON d.id = y.doc_id`,
    )
    .iterate() as IterableIterator<YStateCheckRow>;
}

export function setYStateHeadRev(db: Db, docId: string, headRev: number): void {
  db.prepare('UPDATE doc_ystate SET head_rev = ? WHERE doc_id = ?').run(headRev, docId);
}
