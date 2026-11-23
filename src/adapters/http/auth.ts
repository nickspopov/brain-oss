// HTTP transport authentication: a token only from `Authorization: Bearer`
// (a token in the query string is refused) or a UI session cookie with CSRF protection:
// a mutating request with a cookie must carry `X-Brain-Client` and an `Origin` equal to BRAIN_ORIGIN.
import type { FastifyRequest } from 'fastify';
import type { LoginResult, SessionAuth } from '../../core/sessions.js';
import type { Authenticated } from '../../core/tokens.js';

export type Authenticate = (token: string, ip: string | null) => Authenticated | null;

export interface SessionApi {
  cookieName: string;
  login(name: string, password: string, meta: { ip: string | null; userAgent: string | null }): LoginResult | null;
  authenticate(value: string): SessionAuth | null;
  logout(value: string): void;
  /** Self-service password change of the session's own human. */
  changePassword(value: string, input: { currentPassword: string; newPassword: string }, meta: { ip: string | null }): { revokedSessions: number };
}

/**
  * Failed authentication: audit and per-IP failure limit (in the core). Returns how many
  * ms to wait (0 = answer `unauthenticated`, otherwise `rate_limited`).
 */
export type AuthFailed = (ip: string | null, op: string, counted: boolean, via?: 'rest' | 'mcp') => number;

export interface AuthDeps {
  authenticate: Authenticate;
  authFailed: AuthFailed;
  sessions: SessionApi;
  /** BRAIN_ORIGIN: the Origin header of cookie requests is checked against it. */
  origin: string;
}

export interface RequestAuth {
  principal: Authenticated['principal'];
  tokenId?: string;
  sessionId?: string;
  via: 'rest' | 'ui';
}

const BEARER_RE = /^Bearer[ ]+([^\s]+)\s*$/i;

/** `undefined` = no header; `null` = passed incorrectly (including a token in the query); a string = the token. */
export function bearerToken(req: FastifyRequest): string | null | undefined {
  const query = req.query as Record<string, unknown> | undefined;
  if (query && typeof query === 'object' && ('token' in query || 'access_token' in query)) return null;
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const m = BEARER_RE.exec(header);
  return m?.[1] ?? null;
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** CSRF: our own client header and the Origin of our service. */
export function csrfOk(req: FastifyRequest, origin: string): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const client = req.headers['x-brain-client'];
  return typeof client === 'string' && client.length > 0 && req.headers.origin === origin;
}

/** Whether credentials were presented (header, token in the query, or session cookie). */
export function presentedCredential(req: FastifyRequest, cookieName: string): boolean {
  return bearerToken(req) !== undefined || readCookie(req, cookieName) !== undefined;
}

/**
  * Bearer if present (the cookie is then ignored); otherwise the session cookie. Any refusal is `null`:
  * the reason is not disclosed.
 */
export function authenticateRequest(req: FastifyRequest, deps: AuthDeps): RequestAuth | null {
  const token = bearerToken(req);
  if (token === null) return null;
  if (typeof token === 'string') {
    const a = deps.authenticate(token, req.ip ?? null);
    return a ? { principal: a.principal, tokenId: a.tokenId, via: 'rest' } : null;
  }
  const cookie = readCookie(req, deps.sessions.cookieName);
  if (cookie === undefined) return null;
  if (!csrfOk(req, deps.origin)) return null;
  const s = deps.sessions.authenticate(cookie);
  return s ? { principal: s.principal, sessionId: s.sessionId, via: 'ui' } : null;
}
