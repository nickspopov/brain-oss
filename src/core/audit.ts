// Audit: one row per call. Document contents and tokens never get here.
import { insertAudit, queryAudit } from '../store/audit.js';
import { getPrincipalByName } from '../store/principals.js';
import { getSpaceBySlug } from '../store/spaces.js';
import type { AuditInsert } from '../store/types.js';
import type { Core } from './context.js';
import { openCursor, sealCursor, type CursorOwner } from './cursor.js';

/** Limit of detail: admin rows carry input and result. */
const MAX_DETAIL = 8192;

export interface AuditEntry extends Omit<AuditInsert, 'ts' | 'detail'> {
  detail?: Record<string, unknown> | null;
}

export function recordAudit(core: Core, entry: AuditEntry): void {
  let detail: string | null = null;
  if (entry.detail) {
    detail = JSON.stringify(entry.detail);
    if (detail.length > MAX_DETAIL) {
      // Sacrifice the result first: the input says what exactly was requested.
      const input = 'input' in entry.detail ? JSON.stringify({ input: entry.detail.input, truncated: true }) : undefined;
      detail = input !== undefined && input.length <= MAX_DETAIL ? input : JSON.stringify({ truncated: true });
    }
  }
  insertAudit(core.db, { ...entry, ts: core.now(), detail });
}

/** Rows of one kind of denial per key (IP or principal) per minute. */
export const DENIAL_ROWS_PER_MINUTE = 20;
const MINUTE = 60_000;
const MAX_DENIAL_KEYS = 10_000;

interface DenialWindow {
  start: number;
  written: number;
  suppressed: number;
  /** Skipped in the previous window: goes into detail.suppressed of the first row of the new window. */
  carried: number;
}

const denialWindows = new WeakMap<Core, Map<string, DenialWindow>>();

/**
 * Audit row for a denial that can come as a flood: failed authentication,
 * `rate_limited`, `not_found` for an unknown operation. At most DENIAL_ROWS_PER_MINUTE rows
 * per minute are written per key; skipped ones are counted and go into `detail.suppressed`
 * of the first row of the next minute. Returns whether the row was written.
 */
export function recordDenial(core: Core, key: string, entry: AuditEntry): boolean {
  let windows = denialWindows.get(core);
  if (!windows) {
    windows = new Map();
    denialWindows.set(core, windows);
  }
  const now = core.now();
  let w = windows.get(key);
  if (!w || now - w.start >= MINUTE) {
    if (!w && windows.size >= MAX_DENIAL_KEYS) {
      for (const [k, old] of windows) if (now - old.start >= MINUTE && old.suppressed === 0) windows.delete(k);
      if (windows.size >= MAX_DENIAL_KEYS) windows.clear();
    }
    w = { start: now, written: 0, suppressed: 0, carried: w?.suppressed ?? 0 };
    windows.set(key, w);
  }
  if (w.written >= DENIAL_ROWS_PER_MINUTE) {
    w.suppressed++;
    return false;
  }
  w.written++;
  const carried = w.carried;
  w.carried = 0;
  recordAudit(core, carried > 0 ? { ...entry, detail: { ...(entry.detail ?? {}), suppressed: carried } } : entry);
  return true;
}

export interface AuditQueryInput {
  principal?: string | undefined;
  op?: string | undefined;
  outcome?: string | undefined;
  space?: string | undefined;
  docId?: string | undefined;
  since?: number | undefined;
  until?: number | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface AuditEntryOut {
  id: number;
  ts: number;
  principal: string | null;
  token_id: string | null;
  via: string;
  op: string;
  outcome: string;
  space: string | null;
  doc_id: string | null;
  rev: number | null;
  request_id: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * `admin_audit_query`: the log, newest first, with filters and a cursor.
 * Access (capability `admin`) is checked by execute via `requires`. Unknown principals or
 * spaces in the filter give an empty result.
 */
export function auditQuery(ctx: CursorOwner & { core: Core }, input: AuditQueryInput): { entries: AuditEntryOut[]; next_cursor?: string } {
  const core = ctx.core;
  const params = { ...input, cursor: undefined, limit: undefined };
  const beforeId = input.cursor === undefined ? undefined : openCursor(ctx, 'audit', input.cursor, params);
  let principalId: string | undefined;
  if (input.principal !== undefined) {
    const p = getPrincipalByName(core.db, core.tenantId, input.principal);
    if (!p) return { entries: [] };
    principalId = p.id;
  }
  let spaceId: string | undefined;
  if (input.space !== undefined) {
    const s = getSpaceBySlug(core.db, core.tenantId, input.space);
    if (!s) return { entries: [] };
    spaceId = s.id;
  }
  const rows = queryAudit(core.db, {
    principalId,
    op: input.op,
    outcome: input.outcome,
    spaceId,
    docId: input.docId,
    since: input.since,
    until: input.until,
    beforeId,
    limit: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  const entries = page.map((r) => ({
    id: r.id,
    ts: r.ts,
    principal: r.principal_name,
    token_id: r.token_id,
    via: r.via,
    op: r.op,
    outcome: r.outcome,
    space: r.space_slug,
    doc_id: r.doc_id,
    rev: r.rev,
    request_id: r.request_id,
    ip: r.ip,
    detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>),
  }));
  const last = page[page.length - 1];
  return rows.length > input.limit && last ? { entries, next_cursor: sealCursor(ctx, 'audit', last.id, params) } : { entries };
}
