// Byte routes: file upload, document body, export download, import.
// Adapter without logic: request → route operation input → executeRoute → response. The request
// body here is bytes, not JSON: its own parser in a separate Fastify scope.
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Executor } from '../../ops/execute.js';
import { authenticateRequest, presentedCredential, type AuthDeps, type RequestAuth } from './auth.js';
import { sendCode, sendError, sendOk } from './envelope.js';

export interface FilesDeps extends AuthDeps {
  executor: Executor;
  /** File upload body limit (BRAIN_MAX_FILE_MB). */
  maxFileBytes: number;
  /** Import archive limit (BRAIN_MAX_IMPORT_MB). */
  maxImportBytes: number;
}

type Query = Record<string, string | string[] | undefined>;

/** String query parameters only (a repeated parameter → the first string). */
function q(query: unknown, name: string): string | undefined {
  const v = (query as Query | undefined)?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

/** `filename*` per RFC 5987 and an ASCII fallback without quotes and control characters. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Route operation by method and template (to authenticate before reading the body). */
const ROUTE_OPS: Record<string, string> = {
  'PUT /api/v1/files/:space/*': 'file_upload',
  'GET /api/v1/docs/:id/raw': 'doc_raw',
  'GET /api/v1/exports/:id': 'export_download',
  'POST /api/v1/import': 'import',
};

export function registerFiles(app: FastifyInstance, deps: FilesDeps): void {
  app.register(async (scope) => {
    // Authenticate before reading the body: without a token or session the body is not read at all,
    // and import (superadmin only) accepts a body from nobody else. Otherwise a request without a
    // token held up to BRAIN_MAX_IMPORT_MB in memory (a Buffer outside the V8 heap) and only then got 401.
    const authOf = new WeakMap<FastifyRequest, RequestAuth>();
    const callerOf = (req: FastifyRequest, auth: RequestAuth, requestId?: string) => ({
      principal: auth.principal,
      tokenId: auth.tokenId,
      sessionId: auth.sessionId,
      via: auth.via,
      ip: req.ip ?? null,
      requestId,
    });
    scope.addHook('onRequest', async (req, reply) => {
      const op = ROUTE_OPS[`${req.method} ${req.routeOptions.url ?? ''}`] ?? 'unknown_route';
      const auth = authenticateRequest(req, deps);
      if (!auth) {
        const wait = deps.authFailed(req.ip ?? null, op, presentedCredential(req, deps.sessions.cookieName));
        sendCode(reply, wait > 0 ? 'rate_limited' : 'unauthenticated', wait > 0 ? { retry_after_ms: wait } : undefined);
        return reply;
      }
      authOf.set(req, auth);
      if (op === 'import' && auth.principal.role !== 'superadmin') {
        // The same answer the pipeline would give (operation not visible), but without reading the archive.
        const res = await deps.executor.executeRoute(op, {}, callerOf(req, auth));
        if (!res.ok) {
          sendError(reply, res.status, res.error);
          return reply;
        }
      }
      return undefined;
    });

    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: Math.max(deps.maxFileBytes, deps.maxImportBytes) }, (_req, body, done) => {
      done(null, body);
    });
    scope.setErrorHandler((err: { statusCode?: number; code?: string }, req, reply) => {
      if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return sendCode(reply, 'too_large', { limit: req.url.startsWith('/api/v1/import') ? deps.maxImportBytes : deps.maxFileBytes });
      }
      if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
        return sendCode(reply, 'invalid_input', { issues: [{ path: '', message: 'Bad request.' }] });
      }
      req.log.error({ err }, 'unhandled error');
      return sendCode(reply, 'internal');
    });

    async function call(req: FastifyRequest, reply: FastifyReply, op: string, input: Record<string, unknown>) {
      const auth = authOf.get(req);
      if (!auth) {
        sendCode(reply, 'unauthenticated');
        return undefined;
      }
      const requestId = typeof input.request_id === 'string' ? input.request_id.slice(0, 128) : undefined;
      const res = await deps.executor.executeRoute(op, defined(input), callerOf(req, auth, requestId));
      if (!res.ok) {
        sendError(reply, res.status, res.error);
        return undefined;
      }
      return res.result;
    }

    scope.put<{ Params: { space: string; '*': string } }>('/api/v1/files/:space/*', { bodyLimit: deps.maxFileBytes }, async (req, reply) => {
      const result = await call(req, reply, 'file_upload', {
        space: req.params.space,
        path: req.params['*'],
        bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        expected_rev: q(req.query, 'expected_rev'),
        message: q(req.query, 'message'),
        request_id: q(req.query, 'request_id'),
      });
      if (result !== undefined) return sendOk(reply, result);
      return reply;
    });

    scope.get<{ Params: { id: string } }>('/api/v1/docs/:id/raw', async (req, reply) => {
      const result = (await call(req, reply, 'doc_raw', { id: req.params.id, rev: q(req.query, 'rev') })) as
        | { bytes: Buffer; mime: string; filename: string }
        | undefined;
      if (result === undefined) return reply;
      return reply
        .code(200)
        .header('content-type', result.mime)
        .header('content-disposition', attachment(result.filename))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .send(result.bytes);
    });

    scope.get<{ Params: { id: string } }>('/api/v1/exports/:id', async (req, reply) => {
      const result = (await call(req, reply, 'export_download', { id: req.params.id })) as
        | { file: string; size: number; filename: string }
        | undefined;
      if (result === undefined) return reply;
      return reply
        .code(200)
        .header('content-type', 'application/gzip')
        .header('content-length', String(result.size))
        .header('content-disposition', attachment(result.filename))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(fs.createReadStream(result.file));
    });

    scope.post('/api/v1/import', { bodyLimit: deps.maxImportBytes }, async (req, reply) => {
      const result = await call(req, reply, 'import', {
        space: q(req.query, 'space'),
        mode: q(req.query, 'mode'),
        confirm_secrets: q(req.query, 'confirm_secrets'),
        archive: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      });
      if (result !== undefined) return sendOk(reply, result);
      return reply;
    });
  });
}
