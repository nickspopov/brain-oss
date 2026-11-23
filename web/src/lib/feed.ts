// Feed helpers: feed filters in the URL, "needs attention", proposals (statuses, stale ones),
// audit filters, export labels.
import { ApiError } from '../api/client';
import type { AuditEntry, AuditFilter, ChangeItem, ConflictCurrent, Proposal } from '../api/types';
import { tx } from '../i18n';

// ---------------------------------------------------------------- feed (activity)

export interface FeedFilter {
  space?: string;
  author?: string;
  /** "Needs attention": edits by non-admins in executable spaces. */
  attention: boolean;
}

export function feedFilterFromParams(p: URLSearchParams): FeedFilter {
  const space = p.get('space')?.trim();
  const author = p.get('author')?.trim();
  return { ...(space ? { space } : {}), ...(author ? { author } : {}), attention: p.get('attention') === '1' };
}

export function feedParams(f: FeedFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.space) p.set('space', f.space);
  if (f.author) p.set('author', f.author);
  if (f.attention) p.set('attention', '1');
  return p;
}

/** `activity` input for a filter. The server doesn't filter "needs attention" in `activity`; the client does. */
export function activityInput(f: FeedFilter, before?: string, limit = 50): { space?: string; author?: string; before?: string; limit: number } {
  return { ...(f.space ? { space: f.space } : {}), ...(f.author ? { author: f.author } : {}), ...(before ? { before } : {}), limit };
}

export function visibleItems(items: ChangeItem[], f: FeedFilter): ChangeItem[] {
  return f.attention ? items.filter((i) => i.attention) : items;
}

/**
 * Whether to read the next page on its own: with the "needs attention" filter a page may contain
 * no matching edits at all. We keep reading while there are fewer matches than `want` and the
 * per-click page budget isn't exhausted (so as not to silently download the whole history).
 */
export function shouldAutoLoad(s: { attention: boolean; shown: number; want: number; hasNext: boolean; fetching: boolean; pagesThisRound: number; budget: number }): boolean {
  return s.attention && s.hasNext && !s.fetching && s.shown < s.want && s.pagesThisRound < s.budget;
}

/** Groups the feed by day (local time) for reading on a phone. */
export function groupByDay(items: ChangeItem[], fmt: (d: Date) => string = (d) => d.toLocaleDateString(tx.locale, { day: 'numeric', month: 'long', year: 'numeric' })): { day: string; items: ChangeItem[] }[] {
  const out: { day: string; items: ChangeItem[] }[] = [];
  for (const it of items) {
    const d = new Date(it.created_at);
    const day = Number.isNaN(d.getTime()) ? it.created_at.slice(0, 10) : fmt(d);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, items: [it] });
  }
  return out;
}

// ---------------------------------------------------------------- proposals

export const PROPOSAL_STATUS_LABEL: Record<Proposal['status'], string> = {
  ...tx.feed.status,
};

export type ProposalStatusFilter = Proposal['status'] | 'all';

export function proposalFilterFromParams(p: URLSearchParams): { status: ProposalStatusFilter; space?: string; mine: boolean } {
  const raw = p.get('status');
  const status: ProposalStatusFilter = raw === 'accepted' || raw === 'rejected' || raw === 'withdrawn' || raw === 'all' ? raw : 'open';
  const space = p.get('space')?.trim();
  return { status, ...(space ? { space } : {}), mine: p.get('mine') === '1' };
}

/**
 * Who can accept: the server checks itself (the `admin` role on the path, not one's own, executable → only
 * a human); the UI merely explains refusals that are obvious in advance, so as not to show a button that certainly won't work.
 */
export function acceptBlocker(p: Proposal, me: { name: string; kind: string }): string | null {
  if (p.status !== 'open') return tx.feed.alreadyDecided;
  if (p.author.name === me.name) return tx.feed.ownProposal;
  if (p.human_required && me.kind !== 'human') return tx.feed.humanOnly;
  return null;
}

/**
 * A `conflict` response to accepting: the document's head has moved on. It can only be accepted
 * explicitly on top of the revision the human saw (`expected_rev`).
 */
export function staleHead(err: unknown): ConflictCurrent | null {
  if (!(err instanceof ApiError) || err.code !== 'conflict') return null;
  const cur = err.details?.current as ConflictCurrent | undefined;
  return cur && typeof cur.rev === 'number' ? cur : null;
}

// ---------------------------------------------------------------- audit

const AUDIT_KEYS = ['principal', 'op', 'outcome', 'space', 'doc_id', 'since', 'until'] as const;

export function auditFilterFromParams(p: URLSearchParams): AuditFilter {
  const f: AuditFilter = {};
  for (const k of AUDIT_KEYS) {
    const v = p.get(k)?.trim();
    if (v) f[k] = v;
  }
  return f;
}

export function auditParams(f: AuditFilter): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of AUDIT_KEYS) {
    const v = f[k];
    if (v) p.set(k, v);
  }
  return p;
}

/** `datetime-local` (local time without a zone) → ISO UTC for the server; empty or garbage → `undefined`. */
export function localToIso(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** ISO → a `datetime-local` value in local time. */
export function isoToLocal(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A short audit `detail` line (it contains neither content nor tokens). */
export function auditDetailText(e: AuditEntry): string {
  if (!e.detail) return '';
  return Object.entries(e.detail)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

export function outcomeTone(outcome: string): 'ok' | 'warn' | 'danger' {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'not_found' || outcome === 'forbidden' || outcome === 'unauthenticated' || outcome === 'secret_detected') return 'danger';
  return 'warn';
}
