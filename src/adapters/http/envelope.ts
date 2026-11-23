// Response envelope.
import type { FastifyReply } from 'fastify';
import { errorBody, ERROR_HTTP, type ErrorBody, type ErrorCode } from '../../ops/errors.js';

/** `handoff`: waiting inbox messages and unseen answers of the caller, when there are any. */
export function sendOk(reply: FastifyReply, result: unknown, handoff?: unknown): FastifyReply {
  return reply.code(200).send(handoff === undefined ? { ok: true, result } : { ok: true, result, handoff });
}

export function sendError(reply: FastifyReply, status: number, error: ErrorBody): FastifyReply {
  if (error.code === 'unauthenticated') reply.header('WWW-Authenticate', 'Bearer');
  if (error.code === 'rate_limited' && typeof error.details?.retry_after_ms === 'number') {
    reply.header('Retry-After', String(Math.ceil(error.details.retry_after_ms / 1000)));
  }
  return reply.code(status).send({ ok: false, error });
}

export function sendCode(reply: FastifyReply, code: ErrorCode, details?: Record<string, unknown>): FastifyReply {
  return sendError(reply, ERROR_HTTP[code], errorBody(code, details));
}
