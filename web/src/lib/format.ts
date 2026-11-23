// Labels and formatting of contract values for humans.
import type { Role, Trust } from '../api/types';
import { tx } from '../i18n';

const dtf = new Intl.DateTimeFormat(tx.locale, { dateStyle: 'medium', timeStyle: 'short' });

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtf.format(d);
}

const clock = new Intl.DateTimeFormat(tx.locale, { timeStyle: 'short' });
const dayClock = new Intl.DateTimeFormat(tx.locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "10:42" today, "Nov 12, 10:42" otherwise (Seen · …). */
export function formatClock(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Date(now).toDateString() === d.toDateString() ? clock.format(d) : dayClock.format(d);
}

/** "in 3 days" / "expired": for a TTL deadline. */
export function formatUntil(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return iso;
  if (ms <= 0) return tx.format.expired;
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return tx.format.lessThanHour;
  if (h < 48) return tx.format.inHours(h);
  return tx.format.inDays(Math.round(h / 24));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return tx.format.bytes(bytes);
  if (bytes < 1024 * 1024) return tx.format.kb((bytes / 1024).toFixed(1));
  return tx.format.mb((bytes / 1024 / 1024).toFixed(1));
}

export const TRUST_LABEL: Record<Trust, string> = { admin: 'admin', trusted: 'trusted', limited: 'limited' };

export const ROLE_LABEL: Record<Role, string> = tx.format.role;

export const REVIEW_LABEL: Record<'off' | 'limited' | 'all', string> = tx.format.review;

export const KIND_LABEL: Record<string, string> = tx.format.kind;

/** The last path segment. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}
