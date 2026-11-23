// HTTP server: Fastify, error envelope, JSON parsing, logging without secrets.
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { Executor } from '../../ops/execute.js';
import type { Authenticate, AuthFailed, SessionApi } from './auth.js';
import { sendCode, sendError } from './envelope.js';
import { registerMcp } from '../mcp/http.js';
import { registerDiscovery } from './discovery.js';
import { registerFiles } from './files.js';
import { registerRest } from './rest.js';
import { registerSessionRoutes } from './session.js';
import { registerUi } from './ui.js';

export interface HttpDeps {
  executor: Executor;
  authenticate: Authenticate;
  authFailed: AuthFailed;
  /** Limit for MCP requests other than tools/call: 0 = allowed, otherwise ms until the next attempt. */
  limitMcpRequest: (principalId: string) => number;
  sessions: SessionApi;
  /** BRAIN_ORIGIN (CSRF). */
  origin: string;
  /** Whether a superadmin exists; without one everything except /healthz answers 503. */
  isReady: () => boolean;
  logger: Logger;
  maxRequestBytes: number;
  maxFileBytes: number;
  maxImportBytes: number;
  trustedProxy: number;
  /** Directory of the built UI (BRAIN_WEB_DIR), or `null`. */
  webDir?: string | null;
}

/** Only the path is logged: the query may contain a token or a search string. */
function safeUrl(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

export function buildServer(deps: HttpDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger.child(
      {},
      {
        serializers: {
          req: (req: FastifyRequest) => ({ method: req.method, url: safeUrl(req.url), remoteAddress: req.ip }),
        },
      },
    ) as FastifyBaseLogger,
    bodyLimit: deps.maxRequestBytes,
    trustProxy: deps.trustedProxy > 0 ? (_addr: string, hop: number) => hop < deps.trustedProxy : false,
  });

  // The request body is always JSON regardless of the declared Content-Type (curl -d sends form-urlencoded).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('invalid JSON') as FastifyError;
      err.statusCode = 400;
      err.code = 'BRAIN_INVALID_JSON';
      done(err, undefined);
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    if (!deps.isReady()) {
      return sendError(reply, 503, {
        code: 'internal',
        message: 'Server is not initialized: create a superadmin with `brain admin create`.',
        retryable: true,
      });
    }
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendCode(reply, 'too_large', { limit: deps.maxRequestBytes });
    }
    if (status >= 400 && status < 500) {
      return sendCode(reply, 'invalid_input', { issues: [{ path: '', message: 'Request body must be a JSON object.' }] });
    }
    req.log.error({ err }, 'unhandled error');
    return sendCode(reply, 'internal');
  });

  app.setNotFoundHandler((_req, reply) => sendCode(reply, 'not_found'));

  app.get('/healthz', async () => ({ ok: true }));

  const auth = { authenticate: deps.authenticate, authFailed: deps.authFailed, sessions: deps.sessions, origin: deps.origin };
  registerDiscovery(app, auth);
  registerSessionRoutes(app, { ...auth, secureCookie: deps.origin.startsWith('https://') });
  registerRest(app, { ...auth, executor: deps.executor });
  registerMcp(app, { ...auth, executor: deps.executor, limitRequest: deps.limitMcpRequest });
  registerFiles(app, { ...auth, executor: deps.executor, maxFileBytes: deps.maxFileBytes, maxImportBytes: deps.maxImportBytes });
  registerUi(app, deps.webDir ?? null);
  return app;
}
