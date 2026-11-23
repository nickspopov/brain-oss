// External principals: an agent of another person. Flag + owner label stay regardless of limits (audit, the
// EXTERNAL read header, the warning when sending to one). Limits are per-principal settings with
// defaults; a human may raise or disable each of them (null = no limit).
import { getPrincipalById } from '../store/principals.js';
import type { PrincipalRow } from '../store/types.js';
import type { Core } from './context.js';
import { invalidInput } from './errors.js';

export interface ExternalLimits {
  /** Messages the external may send per UTC day. */
  msgs_per_day: number | null;
  /** Body size of one message, bytes (UTF-8). */
  body_bytes: number | null;
  /** Open (not done/declined) messages from the external to one recipient. */
  pending_per_recipient: number | null;
  /** Lifetime of a token issued to the external, days. */
  token_days: number | null;
}

export const EXTERNAL_DEFAULTS: Readonly<ExternalLimits> = { msgs_per_day: 20, body_bytes: 8 * 1024, pending_per_recipient: 5, token_days: 30 };
/** Title of a message from an external: one line, at most this many characters (not a setting). */
export const EXTERNAL_TITLE_MAX = 80;

const KEYS = Object.keys(EXTERNAL_DEFAULTS) as (keyof ExternalLimits)[];
const MAX: Record<keyof ExternalLimits, number> = { msgs_per_day: 100_000, body_bytes: 256 * 1024, pending_per_recipient: 100_000, token_days: 3650 };

export function isExternal(p: { external?: boolean | 0 | 1 | undefined }): boolean {
  return p.external === true || p.external === 1;
}

/** Effective limits: stored values over the defaults. */
export function limitsOf(row: Pick<PrincipalRow, 'limits'>): ExternalLimits {
  const out: ExternalLimits = { ...EXTERNAL_DEFAULTS };
  if (row.limits === null) return out;
  try {
    const stored = JSON.parse(row.limits) as Partial<Record<keyof ExternalLimits, unknown>>;
    for (const k of KEYS) {
      const v = stored[k];
      if (v === null) out[k] = null;
      else if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
    }
  } catch {
    // unreadable: defaults
  }
  return out;
}

/** Validated JSON to store: the current limits patched with `patch` (null = no limit). */
export function mergeLimits(row: Pick<PrincipalRow, 'limits'>, patch: Partial<Record<keyof ExternalLimits, number | null>>): string {
  const cur = limitsOf(row);
  for (const k of KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === undefined) continue;
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > MAX[k])) throw invalidInput(`limits.${k}`, `Must be an integer 1–${MAX[k]}, or null for no limit.`);
    cur[k] = v;
  }
  return JSON.stringify(cur);
}

/** Start of the UTC day of `now`. */
export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Owner label and effective limits of a principal (defaults if it is gone). */
export function externalInfo(core: Core, principalId: string): { owner_label: string | null; limits: ExternalLimits } {
  const row = getPrincipalById(core.db, principalId);
  return { owner_label: row?.owner_label ?? null, limits: row ? limitsOf(row) : { ...EXTERNAL_DEFAULTS } };
}
