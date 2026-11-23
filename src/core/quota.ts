// Write quotas: space usage by heads, a coarse space history quota, the overall data limit and
// free disk space (refusal before ENOSPC). The check runs inside the write transaction, before the
// body is inserted.
import fs from 'node:fs';
import type { SpaceRow } from '../store/types.js';
import { auditBytes, dataBytes, spaceBytesUsed, spaceHistoryBytes } from '../store/usage.js';
import type { Core } from './context.js';
import { OpError } from './errors.js';

/** Space history (sum of revision bodies) is at most this many head quotas. */
export const HISTORY_QUOTA_FACTOR = 10;

/**
 * Quota of a space or its history. `used` is the size of the whole space, including folders hidden
 * from the caller: only the space administrator (and the superadmin) sees it.
 */
function exceeded(limit: number, used: number, scope: 'space' | 'history', showUsed: boolean): OpError {
  return new OpError('quota_exceeded', { limit, ...(showUsed ? { used } : {}), scope });
}

/**
 * Server data limit and free space: `used` is not returned, since the size of the whole DB depends on
 * writes in invisible spaces (no counters).
 */
function serverExceeded(scope: 'server' | 'disk', limit?: number): OpError {
  return new OpError('quota_exceeded', { ...(limit !== undefined ? { limit } : {}), scope });
}

export interface QuotaCheck {
  space: SpaceRow;
  /** Change of `bytes_used` (live heads). */
  liveDelta: number;
  /** Size of the new body, if the write adds one (otherwise 0). */
  newBodyBytes: number;
  /** Whether to include `used` in the error: only for the space administrator. */
  showUsed?: boolean;
}

export function checkQuota(core: Core, q: QuotaCheck): void {
  if (q.liveDelta > 0) {
    const used = spaceBytesUsed(core.db, q.space.id);
    if (used + q.liveDelta > q.space.quota_bytes) throw exceeded(q.space.quota_bytes, used, 'space', q.showUsed === true);
  }
  if (q.newBodyBytes <= 0) return;
  const historyLimit = q.space.quota_bytes * HISTORY_QUOTA_FACTOR;
  const history = spaceHistoryBytes(core.db, q.space.id);
  if (history + q.newBodyBytes > historyLimit) throw exceeded(historyLimit, history, 'history', q.showUsed === true);
  const limits = core.config.limits;
  const total = dataBytes(core.db, cachedAuditBytes(core));
  if (total + q.newBodyBytes > limits.maxDataBytes) {
    core.log.warn({ total, limit: limits.maxDataBytes }, 'data size limit reached: writes refused');
    throw serverExceeded('server', limits.maxDataBytes);
  }
  const free = freeDiskBytes(core.config.dataDir);
  if (free !== undefined && free - q.newBodyBytes < limits.minFreeBytes) {
    core.log.warn({ free, min: limits.minFreeBytes }, 'free disk space below the floor: writes refused');
    throw serverExceeded('disk');
  }
}

/** How often to recompute the audit size: walking its pages costs more than the write itself. */
const AUDIT_SIZE_TTL_MS = 60_000;
const auditSize = new WeakMap<Core, { at: number; bytes: number }>();

/**
 * Size of the audit table: it is not part of the data limit, since a flood of denials must not
 * stop writes. The audit has its own cap (`BRAIN_AUDIT_MAX_MB`), enforced by the janitor.
 */
export function cachedAuditBytes(core: Core, refresh = false): number {
  const now = core.now();
  const c = auditSize.get(core);
  if (!refresh && c && now - c.at < AUDIT_SIZE_TTL_MS) return c.bytes;
  const bytes = auditBytes(core.db);
  auditSize.set(core, { at: now, bytes });
  return bytes;
}

function freeDiskBytes(dir: string): number | undefined {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}
