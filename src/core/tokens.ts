// Tokens: `brn_` + 43 base64url characters; only sha256 and the prefix are stored in the DB.
// Checked on every request, no cache: revocation takes effect from the next request.
import { createHash, randomBytes } from 'node:crypto';
import type { Kind, PrincipalRow, Trust } from '../store/types.js';
import { findTokenByHash, insertToken, revokeToken as storeRevoke, touchToken } from '../store/tokens.js';
import { recordDenial } from './audit.js';
import type { Core } from './context.js';
import { newId } from './ids.js';

export const TOKEN_PREFIX = 'brn_';
const TOKEN_RE = /^brn_[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssuedToken {
  id: string;
  token: string;
  prefix: string;
  expiresAt: number | null;
}

export interface IssueOptions {
  label?: string;
  /** Lifetime in days; defaults to BRAIN_TOKEN_DAYS. `null` means no expiry (only by explicit choice). */
  days?: number | null;
  createdBy?: string | null;
}

export function issueToken(core: Core, principalId: string, opts: IssueOptions = {}): IssuedToken {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const now = core.now();
  const days = opts.days === undefined ? core.config.tokenDays : opts.days;
  const expiresAt = days === null ? null : now + days * DAY_MS;
  const id = newId(now);
  const prefix = token.slice(0, 12);
  insertToken(core.db, {
    id,
    principal_id: principalId,
    hash: hashToken(token),
    prefix,
    label: opts.label ?? '',
    created_at: now,
    created_by: opts.createdBy ?? null,
    expires_at: expiresAt,
    revoked_at: null,
    revoked_by: null,
    last_used_at: null,
    last_used_ip: null,
  });
  return { id, token, prefix, expiresAt };
}

export function revokeToken(core: Core, tokenId: string, by: string | null): void {
  storeRevoke(core.db, tokenId, core.now(), by);
  // A parked wait for mail on this token ends at once.
  core.waiters.revokeToken(tokenId);
}

/** What the adapter knows about the caller after authentication. */
export interface AuthenticatedPrincipal {
  id: string;
  name: string;
  kind: Kind;
  role: PrincipalRow['role'];
  trust: Trust;
  /** Capability `admin`. */
  admin?: boolean;
  /** External principal. */
  external?: boolean;
}

export interface Authenticated {
  principal: AuthenticatedPrincipal;
  tokenId: string;
}

/**
 * Token check: format → sha256 → tokens row → revocation, expiry, principal disabled.
 * The reason for refusal is never disclosed: any refusal is `null`.
 */
export function authenticateToken(core: Core, token: string, ip: string | null): Authenticated | null {
  if (!TOKEN_RE.test(token)) return null;
  const found = findTokenByHash(core.db, hashToken(token));
  if (!found) return null;
  const { token: row, principal } = found;
  const now = core.now();
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;
  if (principal.disabled_at !== null) return null;
  if (principal.kind === 'system') return null;
  if (row.last_used_at === null || now - row.last_used_at >= TOUCH_INTERVAL_MS) {
    touchToken(core.db, row.id, now, ip);
  }
  return {
    principal: toAuthenticated(principal),
    tokenId: row.id,
  };
}

export function toAuthenticated(p: PrincipalRow): AuthenticatedPrincipal {
  return { id: p.id, name: p.name, kind: p.kind, role: p.role, trust: p.trust, admin: p.can_admin === 1, external: p.external === 1 };
}

/**
 * Failed authentication: an audit row without a principal (only when credentials were presented, throttled) and a charge against
 * the failure limit for this IP (`counted`: whether credentials were presented). Returns in how many ms this IP may try again (0: right away).
 */
export function noteAuthFailure(core: Core, ip: string | null, via: 'rest' | 'ui' | 'mcp' | 'mcpl', op: string, counted = true): number {
  const key = ip ?? 'unknown';
  // A request without credentials (UI not logged in) does not consume the failure limit.
  const wait = counted ? core.limiter.blocked('auth_fail', key) : 0;
  if (counted) core.limiter.spend('auth_fail', key);
  // A request without credentials leaves no row (otherwise the audit grows from an anonymous
  // flood); wrong presented ones get at most DENIAL_ROWS_PER_MINUTE rows per minute per IP.
  if (counted) {
    recordDenial(core, `auth:${key}`, { principal_id: null, token_id: null, via, op, outcome: wait > 0 ? 'rate_limited' : 'unauthenticated', ip });
  }
  return wait;
}
