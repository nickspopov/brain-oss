// Reading and validating environment variables. Only what is needed before the DB is opened.
import path from 'node:path';
import { z } from 'zod';

const flag = z
  .string()
  .optional()
  .transform((v) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false');

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min));

const EnvSchema = z.object({
  BRAIN_HOST: z.string().default('127.0.0.1'),
  BRAIN_PORT: int(7460, 0),
  BRAIN_ORIGIN: z.string().default('http://127.0.0.1:7460'),
  BRAIN_DEV: flag,
  BRAIN_DATA_DIR: z.string().default('./data'),
  BRAIN_TENANT: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .default('default'),
  BRAIN_MAX_DOC_KB: int(512, 1),
  BRAIN_MAX_FILE_MB: int(20, 1),
  BRAIN_MAX_REQUEST_MB: int(2, 1),
  BRAIN_RATE_WRITE: int(30, 1),
  BRAIN_RATE_READ: int(300, 1),
  BRAIN_RATE_SEARCH: int(60, 1),
  BRAIN_RATE_AUTH_FAIL: int(10, 1),
  // GET /api/v1/inbox calls that answer at once (no wait, or mail already there).
  BRAIN_RATE_POLL: int(6, 1),
  // Longest single wait of GET /api/v1/inbox?wait and handoff_wait, seconds (MCP clients time out at 60 s).
  BRAIN_INBOX_WAIT_MAX_S: int(50, 1),
  // Parked waits in the whole process (one per principal).
  BRAIN_INBOX_WAITERS: int(32, 1),
  // Content bytes `read` returns to one principal per minute.
  BRAIN_RATE_READ_MB: int(32, 1),
  // Audit table cap: above it janitor evicts the oldest refusals and reads.
  BRAIN_AUDIT_MAX_MB: int(512, 1),
  // Common limit for the DB and blobs; writes are refused before ENOSPC.
  BRAIN_MAX_DATA_BYTES: int(5 * 1024 * 1024 * 1024, 1),
  BRAIN_MIN_FREE_MB: int(64, 0),
  BRAIN_TOKEN_DAYS: int(90, 1),
  BRAIN_MAX_OPEN_PROPOSALS: int(50, 1),
  // Archive import: request body limit and unpacked size limit.
  BRAIN_MAX_IMPORT_MB: int(256, 1),
  // Background jobs (janitor, webhook delivery); 0 = do not start (tests call them directly).
  BRAIN_BACKGROUND: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === '' || (v !== '0' && v.toLowerCase() !== 'false')),
  BRAIN_WEBHOOK_ALLOW_HOSTS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  BRAIN_TRUSTED_PROXY: int(0, 0),
  // Agent that gets the `admin` capability at startup (e.g. alice-assistant).
  BRAIN_BOOTSTRAP_ADMIN_AGENT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v))
    .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional()),
  // Built UI; an empty string means the UI is not served.
  BRAIN_WEB_DIR: z.string().default('web/dist'),
  BRAIN_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  host: string;
  port: number;
  origin: string;
  dev: boolean;
  dataDir: string;
  tenant: string;
  limits: {
    maxDocBytes: number;
    maxFileBytes: number;
    maxRequestBytes: number;
    ratePerMinute: { write: number; read: number; search: number };
    /** Failed authentications from one IP per minute. */
    authFailuresPerMinute: number;
    /** GET /api/v1/inbox answered at once, per principal per minute. */
    pollPerMinute: number;
    /** Longest single wait for mail, ms (at most 50 s). */
    inboxWaitMaxMs: number;
    /** Parked waits in the process. */
    inboxWaiters: number;
    /** Content bytes of `read` per principal per minute. */
    readBytesPerMinute: number;
    /** Size cap of the audit table (outside `maxDataBytes`). */
    auditMaxBytes: number;
    /** Size limit of the DB plus blob files. */
    maxDataBytes: number;
    /** Free disk space below which writes are refused (before ENOSPC). */
    minFreeBytes: number;
    /** Open proposals per author. */
    maxOpenProposals: number;
    /** Import archive: compressed and unpacked size. */
    maxImportBytes: number;
  };
  /** Run janitor and webhook delivery on a timer. */
  background: boolean;
  tokenDays: number;
  webhookAllowHosts: string[];
  trustedProxy: number;
  bootstrapAdminAgent: string | null;
  /** Directory of the built UI, or `null`. */
  webDir: string | null;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid environment: ${issues}`);
  }
  const e = parsed.data;
  let origin: URL;
  try {
    origin = new URL(e.BRAIN_ORIGIN);
  } catch {
    throw new ConfigError('BRAIN_ORIGIN is not a URL');
  }
  if (origin.protocol !== 'https:' && !e.BRAIN_DEV) {
    throw new ConfigError('BRAIN_ORIGIN must start with https:// unless BRAIN_DEV=1');
  }
  return {
    host: e.BRAIN_HOST,
    port: e.BRAIN_PORT,
    origin: origin.origin,
    dev: e.BRAIN_DEV,
    dataDir: path.resolve(e.BRAIN_DATA_DIR),
    tenant: e.BRAIN_TENANT,
    limits: {
      maxDocBytes: e.BRAIN_MAX_DOC_KB * 1024,
      maxFileBytes: e.BRAIN_MAX_FILE_MB * 1024 * 1024,
      maxRequestBytes: e.BRAIN_MAX_REQUEST_MB * 1024 * 1024,
      ratePerMinute: { write: e.BRAIN_RATE_WRITE, read: e.BRAIN_RATE_READ, search: e.BRAIN_RATE_SEARCH },
      authFailuresPerMinute: e.BRAIN_RATE_AUTH_FAIL,
      pollPerMinute: e.BRAIN_RATE_POLL,
      inboxWaitMaxMs: Math.min(e.BRAIN_INBOX_WAIT_MAX_S, 50) * 1000,
      inboxWaiters: e.BRAIN_INBOX_WAITERS,
      readBytesPerMinute: e.BRAIN_RATE_READ_MB * 1024 * 1024,
      auditMaxBytes: e.BRAIN_AUDIT_MAX_MB * 1024 * 1024,
      maxDataBytes: e.BRAIN_MAX_DATA_BYTES,
      minFreeBytes: e.BRAIN_MIN_FREE_MB * 1024 * 1024,
      maxOpenProposals: e.BRAIN_MAX_OPEN_PROPOSALS,
      maxImportBytes: e.BRAIN_MAX_IMPORT_MB * 1024 * 1024,
    },
    background: e.BRAIN_BACKGROUND,
    tokenDays: e.BRAIN_TOKEN_DAYS,
    webhookAllowHosts: e.BRAIN_WEBHOOK_ALLOW_HOSTS,
    trustedProxy: e.BRAIN_TRUSTED_PROXY,
    bootstrapAdminAgent: e.BRAIN_BOOTSTRAP_ADMIN_AGENT ?? null,
    webDir: e.BRAIN_WEB_DIR === '' ? null : path.resolve(e.BRAIN_WEB_DIR),
    logLevel: e.BRAIN_LOG_LEVEL,
  };
}
