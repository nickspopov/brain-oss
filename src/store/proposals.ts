// Proposals: SQL only, no permissions. Visibility is checked by core/proposals through guard.
import type { Db } from '../db/open.js';
import type { Kind, Trust } from './types.js';

export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn';

export interface ProposalRow {
  id: string;
  space_id: string;
  doc_id: string | null;
  path: string;
  base_rev: number;
  content_hash: string;
  message: string;
  author_id: string;
  author_trust: Trust;
  status: ProposalStatus;
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  result_seq: number | null;
}

/** A proposal with the names of its author and decider (for output). */
export interface ProposalView extends ProposalRow {
  author_name: string;
  author_kind: Kind;
  decider_name: string | null;
  decider_kind: Kind | null;
  decider_trust: Trust | null;
  /** Size of the proposed body. */
  size: number;
  /** The revision created on acceptance (by result_seq). */
  result_rev: number | null;
  /** Row sequence number (rowid): the listing cursor. */
  ord: number;
}

const VIEW = `
  SELECT p.*, p.rowid AS ord, a.name AS author_name, a.kind AS author_kind,
         d.name AS decider_name, d.kind AS decider_kind, d.trust AS decider_trust,
         b.size AS size, r.rev AS result_rev
  FROM proposals p
  JOIN principals a ON a.id = p.author_id
  LEFT JOIN principals d ON d.id = p.decided_by
  JOIN blobs b ON b.hash = p.content_hash
  LEFT JOIN revisions r ON r.seq = p.result_seq`;

export function insertProposal(db: Db, row: ProposalRow): void {
  db.prepare(
    `INSERT INTO proposals (id, space_id, doc_id, path, base_rev, content_hash, message, author_id, author_trust,
       status, created_at, decided_by, decided_at, decision_note, result_seq)
     VALUES (@id, @space_id, @doc_id, @path, @base_rev, @content_hash, @message, @author_id, @author_trust,
       @status, @created_at, @decided_by, @decided_at, @decision_note, @result_seq)`,
  ).run(row);
}

export function getProposalView(db: Db, id: string): ProposalView | undefined {
  return db.prepare(`${VIEW} WHERE p.id = ?`).get(id) as ProposalView | undefined;
}

export interface ProposalQuery {
  spaceIds: readonly string[];
  status?: ProposalStatus | undefined;
  authorId?: string | undefined;
  /** Strictly before this row (rowid). */
  beforeOrd?: number | undefined;
  limit: number;
}

/** Proposals in the spaces, newest first. */
export function listProposalViews(db: Db, q: ProposalQuery): ProposalView[] {
  if (q.spaceIds.length === 0) return [];
  const where = [`p.space_id IN (${q.spaceIds.map(() => '?').join(',')})`];
  const params: (string | number)[] = [...q.spaceIds];
  if (q.status) {
    where.push('p.status = ?');
    params.push(q.status);
  }
  if (q.authorId) {
    where.push('p.author_id = ?');
    params.push(q.authorId);
  }
  if (q.beforeOrd !== undefined) {
    where.push('p.rowid < ?');
    params.push(q.beforeOrd);
  }
  params.push(q.limit);
  return db.prepare(`${VIEW} WHERE ${where.join(' AND ')} ORDER BY p.rowid DESC LIMIT ?`).all(...params) as ProposalView[];
}

export function countOpenProposals(db: Db, authorId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM proposals WHERE author_id = ? AND status = 'open'").get(authorId) as { n: number }).n;
}

export interface ProposalDecision {
  status: Exclude<ProposalStatus, 'open'>;
  decided_by: string;
  decided_at: number;
  decision_note: string | null;
  result_seq: number | null;
  /** For a new-document proposal: the id of the created document. */
  doc_id: string | null;
}

/** Decides an open proposal; `false` if it is no longer open. */
export function decideProposal(db: Db, id: string, d: ProposalDecision): boolean {
  const r = db
    .prepare(
      `UPDATE proposals SET status = @status, decided_by = @decided_by, decided_at = @decided_at,
         decision_note = @decision_note, result_seq = @result_seq,
         doc_id = COALESCE(@doc_id, doc_id)
       WHERE id = @id AND status = 'open'`,
    )
    .run({ id, ...d });
  return r.changes === 1;
}
