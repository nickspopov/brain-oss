// Human UI sessions: a cookie with a random value, only its sha256 in the DB.
// 30 days from last use, at most 90 from login; logout and disabling end them immediately.
import { createHash, randomBytes } from 'node:crypto';
import { getPrincipalByName, updatePrincipal } from '../store/principals.js';
import { deleteOtherSessionsOf, deleteSession, findSessionByHash, insertSession, touchSession } from '../store/sessions.js';
import { recordAudit } from './audit.js';
import type { Core } from './context.js';
import { invalidInput, OpError } from './errors.js';
import { checkPassword } from './principals.js';
import { hashPassword, verifyPassword } from './password.js';
import { toAuthenticated, type AuthenticatedPrincipal } from './tokens.js';

export const SESSION_COOKIE = 'brain_session';
const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * DAY_MS;
export const SESSION_MAX_MS = 90 * DAY_MS;
const TOUCH_INTERVAL_MS = 60 * 1000;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;

function hashSession(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

let dummyHash: string | null = null;
/** For an unknown name the password is still checked: response time does not reveal whether such a human exists. */
function burnPasswordCheck(password: string): void {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  verifyPassword(password, dummyHash);
}

export interface SessionAuth {
  principal: AuthenticatedPrincipal;
  /** Short session identifier for the caller (not the cookie value). */
  sessionId: string;
}

export interface LoginResult extends SessionAuth {
  /** Cookie value; shown once in Set-Cookie. */
  cookie: string;
  expiresAt: number;
}

/** Login by name and password: only a human with a password who is not disabled. Refusal is `null` with no reason. */
/**
 * Password login. From an IP that has exhausted its failure limit, the password is not checked at all:
 * `rate_limited` with `retry_after_ms`.
 */
export function login(core: Core, name: string, password: string, meta: { ip: string | null; userAgent: string | null }): LoginResult | null {
  // A separate failure bucket per (IP, name), apart from tokens: behind a proxy everyone has the same IP,
  // and a broken agent with a garbage token would otherwise lock out a human's login.
  const ipKey = loginLimitKey(meta.ip, name);
  const wait = core.limiter.blocked('auth_fail', ipKey);
  if (wait > 0) {
    recordAudit(core, { principal_id: null, token_id: null, via: 'ui', op: 'auth_login', outcome: 'rate_limited', ip: meta.ip });
    throw new OpError('rate_limited', { retry_after_ms: wait });
  }
  const p = getPrincipalByName(core.db, core.tenantId, name);
  const ok = p !== undefined && p.kind === 'human' && p.password_hash !== null && p.disabled_at === null && verifyPassword(password, p.password_hash);
  if (p === undefined || p.password_hash === null) burnPasswordCheck(password);
  recordAudit(core, { principal_id: ok ? p.id : null, token_id: null, via: 'ui', op: 'auth_login', outcome: ok ? 'ok' : 'unauthenticated', ip: meta.ip });
  if (!ok) {
    core.limiter.spend('auth_fail', ipKey);
    return null;
  }
  const value = randomBytes(32).toString('base64url');
  const now = core.now();
  const idHash = hashSession(value);
  const expiresAt = Math.min(now + SESSION_IDLE_MS, now + SESSION_MAX_MS);
  insertSession(core.db, {
    id_hash: idHash,
    principal_id: p.id,
    created_at: now,
    last_seen_at: now,
    expires_at: expiresAt,
    user_agent: meta.userAgent?.slice(0, 256) ?? null,
  });
  return { principal: toAuthenticated(p), sessionId: idHash.slice(0, 16), cookie: value, expiresAt };
}

/** Cookie check on every request, no cache: idle timeout, absolute lifetime, principal disabled. */
export function authenticateSession(core: Core, value: string): SessionAuth | null {
  if (!SESSION_RE.test(value)) return null;
  const idHash = hashSession(value);
  const found = findSessionByHash(core.db, idHash);
  if (!found) return null;
  const { session, principal } = found;
  const now = core.now();
  if (session.expires_at <= now || now - session.created_at >= SESSION_MAX_MS || now - session.last_seen_at >= SESSION_IDLE_MS) {
    deleteSession(core.db, idHash);
    return null;
  }
  if (principal.disabled_at !== null || principal.kind !== 'human') return null;
  if (now - session.last_seen_at >= TOUCH_INTERVAL_MS) {
    touchSession(core.db, idHash, now, Math.min(now + SESSION_IDLE_MS, session.created_at + SESSION_MAX_MS));
  }
  return { principal: toAuthenticated(principal), sessionId: idHash.slice(0, 16) };
}

export function logout(core: Core, value: string): void {
  if (!SESSION_RE.test(value)) return;
  deleteSession(core.db, hashSession(value));
}

function loginLimitKey(ip: string | null, name: string): string {
  return `login:${ip ?? 'unknown'}:${name.toLowerCase().slice(0, 64)}`;
}

/**
 * Self-service password change: only a human with a live UI session; never a
 * bearer token and never over MCP (adapter route, not a registry op). The current password is checked
 * with the same timing-safe scrypt check and the same failure bucket as login. On success every other
 * session of the principal is revoked; the current one continues.
 */
export function changeOwnPassword(
  core: Core,
  sessionValue: string,
  input: { currentPassword: string; newPassword: string },
  meta: { ip: string | null },
): { revokedSessions: number } {
  const auth = authenticateSession(core, sessionValue);
  if (!auth) throw new OpError('unauthenticated');
  const p = getPrincipalByName(core.db, core.tenantId, auth.principal.name);
  if (p === undefined || p.kind !== 'human' || p.disabled_at !== null) throw new OpError('unauthenticated');
  const audit = (outcome: string) =>
    recordAudit(core, { principal_id: p.id, token_id: null, via: 'ui', op: 'account_password_change', outcome, ip: meta.ip });
  const key = loginLimitKey(meta.ip, p.name);
  const wait = core.limiter.blocked('auth_fail', key);
  if (wait > 0) {
    audit('rate_limited');
    throw new OpError('rate_limited', { retry_after_ms: wait });
  }
  if (p.password_hash === null) {
    burnPasswordCheck(input.currentPassword);
    audit('invalid_input');
    throw invalidInput('current_password', 'This account has no password.');
  }
  if (!verifyPassword(input.currentPassword, p.password_hash)) {
    core.limiter.spend('auth_fail', key);
    audit('wrong_password');
    throw invalidInput('current_password', 'Current password is incorrect.');
  }
  try {
    checkPassword(input.newPassword, 'new_password');
    if (input.newPassword.normalize('NFC') === input.currentPassword.normalize('NFC')) {
      throw invalidInput('new_password', 'The new password must differ from the current one.');
    }
  } catch (err) {
    audit('invalid_input');
    throw err;
  }
  const keep = hashSession(sessionValue);
  const hash = hashPassword(input.newPassword);
  const revoked = core.db.transaction(() => {
    updatePrincipal(core.db, p.id, { password_hash: hash });
    return deleteOtherSessionsOf(core.db, p.id, keep);
  })();
  audit('ok');
  return { revokedSessions: revoked };
}
