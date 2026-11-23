import type { Db } from '../db/open.js';
import type { AuditInsert } from './types.js';

export function insertAudit(db: Db, row: AuditInsert): void {
  db.prepare(
    `INSERT INTO audit (ts, principal_id, token_id, via, op, outcome, space_id, doc_id, rev, request_id, ip, detail)
     VALUES (@ts, @principal_id, @token_id, @via, @op, @outcome, @space_id, @doc_id, @rev, @request_id, @ip, @detail)`,
  ).run({ space_id: null, doc_id: null, rev: null, request_id: null, ip: null, detail: null, ...row });
}

export interface AuditQuery {
  principalId?: string | undefined;
  op?: string | undefined;
  outcome?: string | undefined;
  spaceId?: string | undefined;
  docId?: string | undefined;
  since?: number | undefined;
  until?: number | undefined;
  /** Only rows with an id below this one (a page, newest first). */
  beforeId?: number | undefined;
  limit: number;
}

export interface AuditView {
  id: number;
  ts: number;
  principal_name: string | null;
  token_id: string | null;
  via: string;
  op: string;
  outcome: string;
  space_slug: string | null;
  doc_id: string | null;
  rev: number | null;
  request_id: string | null;
  ip: string | null;
  detail: string | null;
}

/** Audit log, newest first; all filters are prepared-statement parameters. */
export function queryAudit(db: Db, q: AuditQuery): AuditView[] {
  const where: string[] = [];
  const args: Record<string, unknown> = { limit: q.limit };
  const add = (cond: string, key: string, value: unknown) => {
    if (value === undefined) return;
    where.push(cond);
    args[key] = value;
  };
  add('a.principal_id = @principalId', 'principalId', q.principalId);
  add('a.op = @op', 'op', q.op);
  add('a.outcome = @outcome', 'outcome', q.outcome);
  add('a.space_id = @spaceId', 'spaceId', q.spaceId);
  add('a.doc_id = @docId', 'docId', q.docId);
  add('a.ts >= @since', 'since', q.since);
  add('a.ts < @until', 'until', q.until);
  add('a.id < @beforeId', 'beforeId', q.beforeId);
  return db
    .prepare(
      `SELECT a.id, a.ts, p.name AS principal_name, a.token_id, a.via, a.op, a.outcome, s.slug AS space_slug,
              a.doc_id, a.rev, a.request_id, a.ip, a.detail
       FROM audit a
       LEFT JOIN principals p ON p.id = a.principal_id
       LEFT JOIN spaces s ON s.id = a.space_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.id DESC
       LIMIT @limit`,
    )
    .all(args) as AuditView[];
}
