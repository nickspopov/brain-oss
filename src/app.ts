// Process assembly: config → DB → migrations → core → adapters (main.ts).
// Kept apart from main.ts so tests start the very same app (test/helpers/harness.ts).
import { createOrientTracker } from './core/orient.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { Config } from './config.js';
import { bootstrap } from './core/bootstrap.js';
import type { Clock, Core } from './core/context.js';
import { createEventBus } from './core/events.js';
import { startBackground } from './core/janitor.js';
import { enqueueForEvent } from './core/webhooks.js';
import { hasSuperadmin } from './core/principals.js';
import { createRateLimiter } from './core/ratelimit.js';
import { WaiterMap } from './core/waiters.js';
import { ensureSecretKey } from './core/secretkey.js';
import { ensureSearchIndex } from './core/search/index.js';
import { authenticateSession, changeOwnPassword, login, logout, SESSION_COOKIE } from './core/sessions.js';
import { authenticateToken, noteAuthFailure } from './core/tokens.js';
import { loadMigrations, migrate } from './db/migrate.js';
import { openDb } from './db/open.js';
import { buildServer } from './adapters/http/server.js';
import { createExecutor, type Executor } from './ops/execute.js';
import { listOps } from './ops/registry.js';
import { SERVER_VERSION } from './version.js';

export interface AppOptions {
  now?: Clock;
  logStream?: DestinationStream;
}

export interface App {
  core: Core;
  executor: Executor;
  server: FastifyInstance;
  close(): Promise<void>;
}

/** The logger strips headers carrying secrets. */
export function createLogger(config: Config, stream?: DestinationStream): Logger {
  const opts = {
    level: config.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie', '*.password', '*.token'],
      censor: '[redacted]',
    },
  };
  return stream ? pino(opts, stream) : pino(opts);
}

/** Opens the data directory and the DB, applies migrations and bootstrap. Used by the server and the CLI. */
export function openCore(config: Config, opts: AppOptions = {}): Core {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const secretKey = ensureSecretKey(config.dataDir);
  const db = openDb(path.join(config.dataDir, 'brain.db'));
  migrate(db, loadMigrations());
  const now = opts.now ?? Date.now;
  const { tenantId } = bootstrap(db, config.tenant, now(), config.bootstrapAdminAgent);
  const core: Core = {
    db,
    config,
    now,
    log: createLogger(config, opts.logStream),
    tenantId,
    serverVersion: SERVER_VERSION,
    acl: { version: 0 },
    secretKey,
    limiter: createRateLimiter({ config, now: () => now() }),
    events: createEventBus(),
    orient: createOrientTracker(() => now()),
    waiters: new WaiterMap(config.limits.inboxWaiters),
  };
  // Bus subscriber: webhook queue inside the write transaction.
  core.events.subscribe((e) => {
    enqueueForEvent(core, e);
  });
  // Search index for the current tokenizer version.
  if (ensureSearchIndex(core)) core.log.info('search index rebuilt');
  if (config.origin.startsWith('https://') && config.trustedProxy === 0) {
    // Behind a reverse proxy without BRAIN_TRUSTED_PROXY all clients come from one IP: failure limits
    // and the audit see the proxy address.
    core.log.warn('BRAIN_ORIGIN is https but BRAIN_TRUSTED_PROXY=0: behind a reverse proxy every client has the proxy IP');
  }
  return core;
}

export function createApp(config: Config, opts: AppOptions = {}): App {
  const core = openCore(config, opts);
  const executor = createExecutor(core);
  const server = buildServer({
    executor,
    authenticate: (token, ip) => authenticateToken(core, token, ip),
    authFailed: (ip, op, counted, via) => noteAuthFailure(core, ip, via ?? 'rest', op, counted),
    limitMcpRequest: (principalId) => {
      const wait = core.limiter.blocked('read', principalId);
      if (wait === 0) core.limiter.take('read', principalId);
      return wait;
    },
    sessions: {
      cookieName: SESSION_COOKIE,
      login: (name, password, meta) => login(core, name, password, meta),
      authenticate: (value) => authenticateSession(core, value),
      logout: (value) => logout(core, value),
      changePassword: (value, input, meta) => changeOwnPassword(core, value, input, meta),
    },
    origin: config.origin,
    isReady: () => hasSuperadmin(core),
    logger: core.log,
    maxRequestBytes: config.limits.maxRequestBytes,
    maxFileBytes: config.limits.maxFileBytes,
    maxImportBytes: config.limits.maxImportBytes,
    trustedProxy: config.trustedProxy,
    webDir: config.webDir,
  });
  const stopBackground = config.background ? startBackground(core, { readOps: readOpNames() }) : async () => {};
  // server.close() closes idle keep-alive sockets once, at its start. A response still being sent
  // then (a download the client has already read to content-length) leaves its socket idle afterwards,
  // and close waited for keepAliveTimeout (72 s) — flaky test hooks, slow shutdown. While closing,
  // every finished response closes the sockets that became idle.
  let closing = false;
  server.server.on('request', (_req: unknown, res: { once(ev: 'close', cb: () => void): unknown }) => {
    res.once('close', () => {
      if (closing) setImmediate(() => server.server.closeIdleConnections());
    });
  });
  return {
    core,
    executor,
    server,
    async close() {
      // Parked waits first: the HTTP server waits for open requests before it closes.
      core.waiters.closeAll();
      closing = true;
      await server.close();
      await stopBackground();
      core.db.close();
    },
  };
}

/** Read operations: janitor keeps their audit rows for 180 days. */
export function readOpNames(): string[] {
  return listOps()
    .filter((op) => op.effect === 'read')
    .map((op) => op.name);
}
