// REST adapter: POST /api/v1/ops/{name} → execute → envelope. No logic.
import type { FastifyInstance } from 'fastify';
import { EVENTS_FILTERS, type EventsFilter, type Executor } from '../../ops/execute.js';
import { authenticateRequest, presentedCredential, type AuthDeps } from './auth.js';
import { sendCode, sendError, sendOk } from './envelope.js';

const OP_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const INBOX_POLL_PATH = '/api/v1/inbox';

export function registerRest(app: FastifyInstance, deps: AuthDeps & { executor: Executor }): void {
  // "Do I have mail?" without running a model. Bare JSON, no envelope; errors as usual.
  // `?wait=<seconds ≤ 50>` parks until mail arrives or the time is up.
  // `?since=<cursor>` returns the events after a client-held cursor (an unusable cursor
  // answers `resync: true` with the level snapshot, never an error); `?events=inbox|answers|both`.
  app.get<{ Querystring: { wait?: string; since?: string; events?: string } }>(INBOX_POLL_PATH, async (req, reply) => {
    const auth = authenticateRequest(req, deps);
    if (!auth) {
      const wait = deps.authFailed(req.ip ?? null, 'inbox_poll', presentedCredential(req, deps.sessions.cookieName));
      return wait > 0 ? sendCode(reply, 'rate_limited', { retry_after_ms: wait }) : sendCode(reply, 'unauthenticated');
    }
    const raw = req.query.wait;
    if (raw !== undefined && !/^\d{1,4}$/.test(raw)) {
      return sendCode(reply, 'invalid_input', { issues: [{ path: 'wait', message: 'Seconds to wait: an integer 0–50.' }] });
    }
    const events = req.query.events;
    if (events !== undefined && !(EVENTS_FILTERS as readonly string[]).includes(events)) {
      return sendCode(reply, 'invalid_input', { issues: [{ path: 'events', message: 'One of inbox, answers, both.' }] });
    }
    // A repeated parameter arrives as an array: garbage, so resync.
    const since = req.query.since === undefined ? undefined : typeof req.query.since === 'string' ? req.query.since : '';
    const waitMs = raw === undefined ? 0 : Math.min(Number(raw), 50) * 1000;
    // The client going away releases the parked wait at once.
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());
    const res = await deps.executor.inboxPoll(
      { principal: auth.principal, tokenId: auth.tokenId, sessionId: auth.sessionId, via: auth.via, ip: req.ip ?? null, signal: abort.signal },
      waitMs,
      { since, events: events as EventsFilter | undefined },
    );
    if (!res.ok) return sendError(reply, res.status, res.error);
    return reply.code(200).header('cache-control', 'no-store').send(res.result);
  });

  app.post<{ Params: { name: string } }>('/api/v1/ops/:name', async (req, reply) => {
    const name = OP_NAME_RE.test(req.params.name) ? req.params.name : '';
    const auth = authenticateRequest(req, deps);
    if (!auth) {
      const wait = deps.authFailed(req.ip ?? null, name || 'unknown', presentedCredential(req, deps.sessions.cookieName));
      return wait > 0 ? sendCode(reply, 'rate_limited', { retry_after_ms: wait }) : sendCode(reply, 'unauthenticated');
    }
    const body = req.body;
    const requestId =
      body && typeof body === 'object' && typeof (body as { request_id?: unknown }).request_id === 'string'
        ? ((body as { request_id: string }).request_id.slice(0, 128))
        : undefined;
    // Operation answers are per caller and may carry a secret shown once (a token, a Connect-agent bundle).
    reply.header('cache-control', 'no-store');
    const res = await deps.executor.execute(name, body ?? {}, {
      principal: auth.principal,
      tokenId: auth.tokenId,
      sessionId: auth.sessionId,
      via: auth.via,
      ip: req.ip ?? null,
      requestId,
    });
    if (res.ok) return sendOk(reply, res.result, res.handoff);
    return sendError(reply, res.status, res.error);
  });
}
