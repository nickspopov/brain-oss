import type { Db } from '../db/open.js';
import type { PrincipalRow, TokenRow } from './types.js';

export function insertToken(db: Db, row: TokenRow): void {
  db.prepare(
    `INSERT INTO tokens (id, principal_id, hash, prefix, label, created_at, created_by, expires_at,
       revoked_at, revoked_by, last_used_at, last_used_ip)
     VALUES (@id, @principal_id, @hash, @prefix, @label, @created_at, @created_by, @expires_at,
       @revoked_at, @revoked_by, @last_used_at, @last_used_ip)`,
  ).run(row);
}

export interface TokenWithPrincipal {
  token: TokenRow;
  principal: PrincipalRow;
}

/** Lookup by hash together with the owner; revocation and expiry checks are done by core/tokens. */
export function findTokenByHash(db: Db, hash: string): TokenWithPrincipal | undefined {
  const token = db.prepare('SELECT * FROM tokens WHERE hash = ?').get(hash) as TokenRow | undefined;
  if (!token) return undefined;
  const principal = db.prepare('SELECT * FROM principals WHERE id = ?').get(token.principal_id) as
    | PrincipalRow
    | undefined;
  if (!principal) return undefined;
  return { token, principal };
}

export function getTokenById(db: Db, id: string): TokenRow | undefined {
  return db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as TokenRow | undefined;
}

/** Tokens of the tenant (or of one principal), newest first. */
export function listTokens(db: Db, tenantId: string, principalId?: string): TokenRow[] {
  if (principalId !== undefined) {
    return db.prepare('SELECT * FROM tokens WHERE principal_id = ? ORDER BY created_at DESC, id DESC').all(principalId) as TokenRow[];
  }
  return db
    .prepare(
      `SELECT t.* FROM tokens t JOIN principals p ON p.id = t.principal_id
       WHERE p.tenant_id = ? ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all(tenantId) as TokenRow[];
}

export function touchToken(db: Db, id: string, at: number, ip: string | null): void {
  db.prepare('UPDATE tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(at, ip, id);
}

export function revokeToken(db: Db, id: string, at: number, by: string | null): void {
  db.prepare('UPDATE tokens SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(at, by, id);
}
