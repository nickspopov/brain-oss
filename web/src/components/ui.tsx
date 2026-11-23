// Small shared elements: badges, loading state, error.
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import type { Author, Trust } from '../api/types';
import { KIND_LABEL } from '../lib/format';
import { tx } from '../i18n';

const TRUST_CLASS: Record<Trust, string> = {
  admin: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
  trusted: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300',
  limited: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-300',
};

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'info' | 'warn' | 'danger' | 'ok'; title?: string }) {
  const cls = {
    neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    info: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300',
    warn: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-300',
    danger: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
    ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}>
      {children}
    </span>
  );
}

export function TrustBadge({ trust, label }: { trust: Trust; label?: string }) {
  return (
    <span title={tx.ui.trustTitle(trust)} className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${TRUST_CLASS[trust]}`}>
      {label ? `${label}: ` : ''}
      {trust}
    </span>
  );
}

/**
 * Author of an edit. Trust is hidden in lists and the feed; it is shown
 * where it matters — proposal decisions (`trust`).
 */
export function AuthorLine({ author, trust = false }: { author: Author; trust?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-medium">{author.name}</span>
      <span className="text-xs text-zinc-500">{KIND_LABEL[author.kind] ?? author.kind}</span>
      {trust && <TrustBadge trust={author.trust} />}
    </span>
  );
}

export function Spinner({ label = tx.common.loading }: { label?: string }) {
  return (
    <div role="status" className="p-4 text-sm text-zinc-500">
      {label}
    </div>
  );
}

/** Human-readable error text; `not_found` doesn't distinguish "doesn't exist" from "no access". */
export function errorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return tx.errors.generic;
  switch (code) {
    case 'not_found':
      return tx.errors.not_found;
    case 'forbidden':
      return tx.errors.forbidden;
    case 'purged':
      return tx.errors.purged;
    case 'rate_limited':
      return tx.errors.rate_limited;
    case 'network':
      return tx.errors.network;
    case 'unsupported':
      return tx.errors.unsupported;
    default:
      return (err instanceof ApiError && err.message) || tx.errors.server;
  }
}

export function ErrorView({ error }: { error: unknown }) {
  return (
    <div role="alert" className="m-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {errorText(error)}
    </div>
  );
}
