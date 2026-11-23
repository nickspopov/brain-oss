import type { Db } from '../db/open.js';
import type { PrincipalRow, SessionRow } from './types.js';

export function insertSession(db: Db, row: SessionRow): void {
  db.prepare(
    `INSERT INTO sessions (id_hash, principal_id, created_at, last_seen_at, expires_at, user_agent)
     VALUES (@id_hash, @principal_id, @created_at, @last_seen_at, @expires_at, @user_agent)`,
  ).run(row);
}

export function findSessionByHash(db: Db, idHash: string): { session: SessionRow; principal: PrincipalRow } | undefined {
  const session = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
  if (!session) return undefined;
  const principal = db.prepare('SELECT * FROM principals WHERE id = ?').get(session.principal_id) as PrincipalRow | undefined;
  if (!principal) return undefined;
  return { session, principal };
}

export function touchSession(db: Db, idHash: string, at: number, expiresAt: number): void {
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(at, expiresAt, idHash);
}

export function deleteSession(db: Db, idHash: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

export function deleteSessionsOf(db: Db, principalId: string): void {
  db.prepare('DELETE FROM sessions WHERE principal_id = ?').run(principalId);
}

/** All sessions of the principal except one (self-service password change keeps the current session). */
export function deleteOtherSessionsOf(db: Db, principalId: string, keepIdHash: string): number {
  return db.prepare('DELETE FROM sessions WHERE principal_id = ? AND id_hash <> ?').run(principalId, keepIdHash).changes;
}
