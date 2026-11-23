import type { Db } from '../db/open.js';
import type { IdempotencyRow } from './types.js';

export function getIdempotency(db: Db, principalId: string, requestId: string): IdempotencyRow | undefined {
  return db.prepare('SELECT * FROM idempotency WHERE principal_id = ? AND request_id = ?').get(principalId, requestId) as
    | IdempotencyRow
    | undefined;
}

export function insertIdempotency(db: Db, row: IdempotencyRow): void {
  db.prepare(
    `INSERT INTO idempotency (principal_id, request_id, op, input_hash, response, created_at)
     VALUES (@principal_id, @request_id, @op, @input_hash, @response, @created_at)`,
  ).run(row);
}
