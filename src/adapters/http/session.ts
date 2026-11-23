// Human sign-in: adapter routes, not registry operations.
// POST /api/v1/auth/login, POST /api/v1/auth/logout, GET /api/v1/auth/session,
// POST /api/v1/auth/password (account_password_change: own password, cookie session only, never bearer/MCP).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SESSION_MAX_MS } from '../../core/sessions.js';
import { OpError } from '../../ops/errors.js';
import { authenticateRequest, bearerToken, csrfOk, readCookie, type AuthDeps, type SessionApi } from './auth.js';
import { sendCode, sendError, sendOk } from './envelope.js';

export interface SessionRouteDeps extends AuthDeps {
  /** Secure flag on the cookie: always, except for an http origin in dev mode. */
  secureCookie: boolean;
}

function cookieHeader(deps: SessionRouteDeps, value: string, maxAgeSec: number): string {
  const parts = [`${deps.sessions.cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (deps.secureCookie) parts.push('Secure');
  return parts.join('; ');
}

function principalOut(p: { name: string; kind: string; trust: string; role: string; admin?: boolean | undefined }) {
  return { name: p.name, kind: p.kind, trust: p.trust, role: p.role, admin: p.role === 'superadmin' || p.admin === true };
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  app.post('/api/v1/auth/login', async (req, reply) => {
    if (!csrfOk(req, deps.origin)) return sendCode(reply, 'unauthenticated');
    const body = req.body as { name?: unknown; password?: unknown } | null;
    if (!body || typeof body.name !== 'string' || typeof body.password !== 'string' || body.password.length > 1024) {
      return sendCode(reply, 'invalid_input', { issues: [{ path: '', message: 'Expected {name, password}.' }] });
    }
    const ua = req.headers['user-agent'];
    let r: ReturnType<SessionApi['login']>;
    try {
      r = deps.sessions.login(body.name.slice(0, 63), body.password, { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null });
    } catch (err) {
      if (err instanceof OpError) return sendError(reply, err.httpStatus, err.toBody());
      throw err;
    }
    if (!r) return sendCode(reply, 'unauthenticated');
    // The cookie lifetime is the maximum (90 days); the server checks idle timeout and disabling itself on every request.
    reply.header('Set-Cookie', cookieHeader(deps, r.cookie, Math.floor(SESSION_MAX_MS / 1000)));
    return sendOk(reply, { principal: principalOut(r.principal) });
  });

  app.post('/api/v1/auth/logout', async (req, reply: FastifyReply) => {
    const cookie = readCookie(req, deps.sessions.cookieName);
    if (cookie !== undefined) {
      if (!csrfOk(req, deps.origin)) return sendCode(reply, 'unauthenticated');
      deps.sessions.logout(cookie);
    }
    reply.header('Set-Cookie', cookieHeader(deps, '', 0));
    return sendOk(reply, { logged_out: true });
  });

  app.get('/api/v1/auth/session', async (req, reply) => {
    const auth = authenticateRequest(req, deps);
    if (!auth || auth.via !== 'ui') return sendCode(reply, 'unauthenticated');
    return sendOk(reply, { principal: principalOut(auth.principal) });
  });

  app.post('/api/v1/auth/password', async (req, reply) => {
    // Cookie session only: a bearer token (even next to a cookie) is refused.
    if (bearerToken(req) !== undefined) return sendCode(reply, 'unauthenticated');
    const cookie = readCookie(req, deps.sessions.cookieName);
    if (cookie === undefined || !csrfOk(req, deps.origin)) return sendCode(reply, 'unauthenticated');
    const body = req.body as { current_password?: unknown; new_password?: unknown } | null;
    if (
      !body ||
      typeof body.current_password !== 'string' ||
      typeof body.new_password !== 'string' ||
      body.current_password.length === 0 ||
      body.current_password.length > 1024 ||
      body.new_password.length > 1024
    ) {
      return sendCode(reply, 'invalid_input', { issues: [{ path: '', message: 'Expected {current_password, new_password}.' }] });
    }
    try {
      const r = deps.sessions.changePassword(cookie, { currentPassword: body.current_password, newPassword: body.new_password }, { ip: req.ip ?? null });
      return sendOk(reply, { changed: true, revoked_sessions: r.revokedSessions });
    } catch (err) {
      if (err instanceof OpError) return sendError(reply, err.httpStatus, err.toBody());
      throw err;
    }
  });
}
