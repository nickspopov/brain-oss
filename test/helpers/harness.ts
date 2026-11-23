// The real application on a temporary directory and a random port. No DB mocks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createApp, type App } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { Core } from '../../src/core/context.js';
import { runDoctor, type DoctorReport } from '../../src/core/doctor.js';
import { loadMigrations } from '../../src/db/migrate.js';
import { Unimplemented } from './pending.js';

/** Controllable clock: real time plus an offset that the test moves forward. */
export class TestClock {
  private offset = 0;
  now = (): number => Date.now() + this.offset;
  advance(ms: number): void {
    this.offset += ms;
  }
  advanceDays(days: number): void {
    this.advance(days * 24 * 60 * 60 * 1000);
  }
}

export interface Harness {
  url: string;
  app: App;
  core: Core;
  config: Config;
  clock: TestClock;
  dataDir: string;
  /** All process log lines (JSON), to check that secrets and tokens did not leak into them. */
  logs: string[];
  doctor(): DoctorReport;
  /** How many HTTP operation calls reached the route handler (after body parsing). */
  opCalls(): number;
  /** Audit lines from operation calls over HTTP (one per call). */
  auditedCalls(): number;
  /** Throws Unimplemented if the route does not exist yet. */
  requireRoute(method: 'GET' | 'PUT' | 'POST', routePattern: string): void;
  close(): Promise<void>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  /** Do not delete the data directory on close (for checks after shutdown). */
  keepData?: boolean;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
  const config = loadConfig({
    BRAIN_DEV: '1',
    BRAIN_DATA_DIR: dataDir,
    BRAIN_PORT: '0',
    BRAIN_LOG_LEVEL: 'info',
    // Scenarios like a03 make hundreds of writes per minute; rate limits are checked by dedicated tests.
    BRAIN_RATE_WRITE: '100000',
    BRAIN_RATE_READ: '100000',
    BRAIN_RATE_SEARCH: '100000',
    BRAIN_RATE_POLL: '100000',
    BRAIN_RATE_AUTH_FAIL: '100000',
    BRAIN_RATE_READ_MB: '100000',
    // Tests call the janitor and webhook delivery directly; background loops are enabled by the tests that need them.
    BRAIN_BACKGROUND: '0',
    // The UI is not served: test results do not depend on whether web/dist is built (the UI test sets the directory itself).
    BRAIN_WEB_DIR: '',
    ...opts.env,
  });
  const clock = new TestClock();
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString('utf8'));
      cb();
    },
  });
  const app = createApp(config, { now: clock.now, logStream });
  let opCalls = 0;
  // File/raw/export/import routes authenticate before reading the body: a rejection is answered from
  // their scope's onRequest, before preHandler, so their calls are counted per HTTP request.
  // A body-size rejection by the parser (413) is not counted as an operation, as before.
  // Counted when headers are sent, not on 'finish': the client may finish reading a streamed body
  // (export) before the server gets 'finish', and the afterEach check would see an extra audit line.
  // A request without credentials leaves no audit line and is not counted as a call.
  const anonymous = (headers: Record<string, unknown>) => headers.authorization === undefined && headers.cookie === undefined;
  app.server.server.on('request', (req: { url?: string; headers: Record<string, unknown> }, res: { statusCode: number; writeHead: (...a: unknown[]) => unknown }) => {
    if (!/^\/api\/v1\/(files\/|docs\/[^/]+\/raw|exports\/|import)/.test(req.url ?? '') || anonymous(req.headers)) return;
    const writeHead = res.writeHead;
    let counted = false;
    res.writeHead = function (this: unknown, ...args: unknown[]) {
      const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
      if (!counted && status !== 413) opCalls++;
      counted = true;
      return writeHead.apply(this, args);
    };
  });
  app.server.addHook('preHandler', async (req) => {
    if (anonymous(req.headers)) return;
    // One audit line per operation call and per call of a file/raw/export/import route.
    if (/^\/api\/v1\/ops\//.test(req.url)) opCalls++;
    // MCP: an operation call is tools/call; initialize and tools/list are not operations.
    else if (req.url === '/mcp/v1' && (req.body as { method?: unknown } | undefined)?.method === 'tools/call') opCalls++;
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    app,
    core: app.core,
    config,
    clock,
    dataDir,
    logs,
    doctor: () => runDoctor(app.core.db, { expectedSchemaVersion: loadMigrations().length }),
    opCalls: () => opCalls,
    auditedCalls: () =>
      (app.core.db.prepare("SELECT count(*) AS n FROM audit WHERE via IN ('rest', 'ui', 'mcp') AND op NOT LIKE 'auth\\_%' ESCAPE '\\' AND op NOT LIKE 'mcp\\_%' ESCAPE '\\'").get() as { n: number }).n,
    requireRoute(method, routePattern) {
      if (!app.server.hasRoute({ method, url: routePattern })) throw new Unimplemented(`route ${method} ${routePattern}`);
    },
    async close() {
      await app.close();
      if (!opts.keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
