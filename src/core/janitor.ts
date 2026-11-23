// Janitor: every 10 minutes as `system`: document TTL (expire revision), final purge of
// the trash after trash_retention_days, cleanup of idempotency (7 days), sessions, export
// files, reads in the audit (180 days), orphans in data/blobs and old webhook queue rows.
// Webhook delivery runs in its own, more frequent loop (core/webhooks.deliverDue).
import fs from 'node:fs';
import path from 'node:path';
import {
  blobExists,
  deleteAuditDenialsBefore,
  deleteAuditReadsBefore,
  evictAuditRows,
  deleteExpiredSessions,
  deleteExport,
  deleteIdempotencyBefore,
  expiredDocIds,
  expiredExports,
  trashDueDocIds,
} from '../store/janitor.js';
import { getPrincipalByName } from '../store/principals.js';
import { pruneMailEvents } from '../store/mailevents.js';
import { pruneOutbox } from '../store/webhooks.js';
import { sweepOrphanBlobs } from './blobs.js';
import { SYSTEM_PRINCIPAL } from './bootstrap.js';
import type { Core } from './context.js';
import { cachedAuditBytes } from './quota.js';
import { expireDocument, type WriteContext } from './documents.js';
import { contextFor } from './guard.js';
import { purgeDocument } from './purge.js';
import { deliverDue } from './webhooks.js';

const DAY = 24 * 60 * 60 * 1000;
export const JANITOR_INTERVAL_MS = 10 * 60 * 1000;
export const DELIVERY_INTERVAL_MS = 15 * 1000;
export const IDEMPOTENCY_TTL_MS = 7 * DAY;
export const AUDIT_READS_TTL_MS = 180 * DAY;
export const OUTBOX_TTL_MS = 7 * DAY;
/** Mail events kept this long; an older cursor resynchronises. */
export const MAIL_EVENTS_TTL_MS = 30 * DAY;
const BATCH = 500;
const EVICT_BATCH = 5000;
const EVICT_ROUNDS = 200;

export interface JanitorOptions {
  /** Names of read operations: their audit rows are kept for 180 days. */
  readOps: readonly string[];
}

export interface JanitorReport {
  expired: number;
  purged: number;
  idempotency: number;
  sessions: number;
  auditReads: number;
  /** Denial floods older than 180 days. */
  auditDenials: number;
  /** Rows evicted by the audit cap BRAIN_AUDIT_MAX_MB. */
  auditEvicted: number;
  exports: number;
  orphanBlobs: number;
  outbox: number;
  /** Mail events older than MAIL_EVENTS_TTL_MS. */
  mailEvents: number;
}

/** Write context of the system author (janitor). */
export function systemContext(core: Core, op: string): WriteContext {
  const row = getPrincipalByName(core.db, core.tenantId, SYSTEM_PRINCIPAL);
  if (!row || row.kind !== 'system') throw new Error('system principal is missing');
  const principal = { id: row.id, name: row.name, kind: row.kind, role: row.role, trust: row.trust };
  return { ...contextFor(core, principal), via: 'system', tokenId: null, ip: null, op, requestId: null };
}

function insideDataDir(core: Core, file: string): string | undefined {
  const abs = path.resolve(core.config.dataDir, file);
  const root = path.resolve(core.config.dataDir) + path.sep;
  return abs.startsWith(root) ? abs : undefined;
}

/** One janitor pass. Each step is independent: a failure in one does not stop the others. */
export function runJanitor(core: Core, opts: JanitorOptions): JanitorReport {
  const report: JanitorReport = { expired: 0, purged: 0, idempotency: 0, sessions: 0, auditReads: 0, auditDenials: 0, auditEvicted: 0, exports: 0, orphanBlobs: 0, outbox: 0, mailEvents: 0 };
  const step = (name: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      core.log.error({ err, step: name }, 'janitor step failed');
    }
  };
  step('expire', () => {
    const ctx = systemContext(core, 'expire');
    for (const id of expiredDocIds(core.db, core.now(), BATCH)) {
      if (expireDocument(ctx, id)) report.expired++;
    }
    if (report.expired > 0) core.events.notifyCommitted();
  });
  step('trash', () => {
    for (const id of trashDueDocIds(core.db, core.now(), BATCH)) {
      if (purgeDocument(core, id).purged) report.purged++;
    }
  });
  step('idempotency', () => {
    report.idempotency = deleteIdempotencyBefore(core.db, core.now() - IDEMPOTENCY_TTL_MS);
  });
  step('sessions', () => {
    report.sessions = deleteExpiredSessions(core.db, core.now());
  });
  step('audit', () => {
    report.auditReads = deleteAuditReadsBefore(core.db, core.now() - AUDIT_READS_TTL_MS, opts.readOps);
    report.auditDenials = deleteAuditDenialsBefore(core.db, core.now() - AUDIT_READS_TTL_MS);
    // Audit cap: the oldest denial floods and reads are evicted; writes stay.
    for (let i = 0; i < EVICT_ROUNDS && cachedAuditBytes(core, true) > core.config.limits.auditMaxBytes; i++) {
      const n = evictAuditRows(core.db, EVICT_BATCH, opts.readOps);
      report.auditEvicted += n;
      if (n === 0) {
        core.log.warn({ limit: core.config.limits.auditMaxBytes }, 'audit is over its ceiling and holds only writes');
        break;
      }
    }
  });
  step('exports', () => {
    for (const e of expiredExports(core.db, core.now())) {
      const file = insideDataDir(core, e.file);
      if (file) fs.rmSync(file, { force: true });
      deleteExport(core.db, e.id);
      report.exports++;
    }
  });
  step('blobs', () => {
    report.orphanBlobs = sweepOrphanBlobs(core, (hash) => blobExists(core.db, hash));
  });
  step('outbox', () => {
    report.outbox = pruneOutbox(core.db, core.now() - OUTBOX_TTL_MS);
  });
  step('mail_events', () => {
    report.mailEvents = pruneMailEvents(core.db, core.now() - MAIL_EVENTS_TTL_MS);
  });
  return report;
}

/**
 * Background loops of the process: janitor every 10 minutes, webhook delivery every 15 seconds and
 * right after a write with an event is committed. Timers do not keep the process alive. Returns a stop function.
 */
export function startBackground(core: Core, opts: JanitorOptions): () => Promise<void> {
  let stopped = false;
  let inflight: Promise<unknown> = Promise.resolve();
  const deliver = (): void => {
    if (!stopped) inflight = deliverDue(core);
  };
  const janitor = setInterval(() => {
    if (!stopped) runJanitor(core, opts);
  }, JANITOR_INTERVAL_MS);
  const delivery = setInterval(deliver, DELIVERY_INTERVAL_MS);
  janitor.unref();
  delivery.unref();
  const off = core.events.afterCommit(() => setImmediate(deliver));
  return async () => {
    stopped = true;
    clearInterval(janitor);
    clearInterval(delivery);
    off();
    await inflight;
  };
}
