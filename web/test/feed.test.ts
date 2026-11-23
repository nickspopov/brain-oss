// Feed helpers: feed and audit filters in the URL, "needs attention", deciding on a proposal.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import type { AuditEntry, ChangeItem, Proposal } from '../src/api/types';
import {
  acceptBlocker,
  activityInput,
  auditDetailText,
  auditFilterFromParams,
  auditParams,
  feedFilterFromParams,
  feedParams,
  groupByDay,
  isoToLocal,
  localToIso,
  outcomeTone,
  proposalFilterFromParams,
  shouldAutoLoad,
  staleHead,
  visibleItems,
} from '../src/lib/feed';
import { routes } from '../src/lib/routes';

const item = (n: number, over: Partial<ChangeItem> = {}): ChangeItem => ({
  rev: n,
  kind: 'update',
  author: { name: 'a', kind: 'agent', trust: 'trusted' },
  via: 'mcp',
  message: '',
  created_at: '2026-11-14T10:00:00.000Z',
  size: 1,
  content_hash: 'h',
  purged: false,
  attention: false,
  doc: { id: `D${n}`, space: 's', path: `p${n}.md`, title: '' },
  ...over,
});

describe('feed filter', () => {
  it('round-trips through the address; blanks are dropped', () => {
    const f = feedFilterFromParams(new URLSearchParams('space=shared&author=%20alphabot%20&attention=1'));
    expect(f).toEqual({ space: 'shared', author: 'alphabot', attention: true });
    expect(feedParams(f).toString()).toBe('space=shared&author=alphabot&attention=1');
    expect(feedFilterFromParams(new URLSearchParams('space=&attention=0'))).toEqual({ attention: false });
    expect(routes.feed({ space: 'a b', attention: true })).toBe('/feed?space=a+b&attention=1');
    expect(routes.feed()).toBe('/feed');
  });

  it('activity input carries only set fields; attention is a client filter', () => {
    expect(activityInput({ attention: true })).toEqual({ limit: 50 });
    expect(activityInput({ space: 's', author: 'x', attention: false }, 'C', 20)).toEqual({ space: 's', author: 'x', before: 'C', limit: 20 });
    const xs = [item(1), item(2, { attention: true })];
    expect(visibleItems(xs, { attention: true }).map((i) => i.rev)).toEqual([2]);
    expect(visibleItems(xs, { attention: false })).toHaveLength(2);
  });

  it('auto-load only for attention, while short, within the page budget', () => {
    const base = { attention: true, shown: 0, want: 20, hasNext: true, fetching: false, pagesThisRound: 1, budget: 10 };
    expect(shouldAutoLoad(base)).toBe(true);
    expect(shouldAutoLoad({ ...base, attention: false })).toBe(false);
    expect(shouldAutoLoad({ ...base, shown: 20 })).toBe(false);
    expect(shouldAutoLoad({ ...base, hasNext: false })).toBe(false);
    expect(shouldAutoLoad({ ...base, fetching: true })).toBe(false);
    expect(shouldAutoLoad({ ...base, pagesThisRound: 10 })).toBe(false);
  });

  it('groups consecutive items by day', () => {
    const g = groupByDay([item(1), item(2), item(3, { created_at: '2026-11-13T10:00:00.000Z' })], (d) => d.toISOString().slice(0, 10));
    expect(g.map((x) => [x.day, x.items.length])).toEqual([
      ['2026-11-14', 2],
      ['2026-11-13', 1],
    ]);
  });
});

const prop = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'P',
  space: 's',
  path: 'p.md',
  base_rev: 1,
  content_hash: 'h',
  size: 1,
  message: '',
  author: { name: 'alphabot', kind: 'agent', trust: 'limited' },
  status: 'open',
  created_at: '',
  human_required: false,
  ...over,
});

describe('proposals', () => {
  it('status filter defaults to open; unknown values fall back', () => {
    expect(proposalFilterFromParams(new URLSearchParams(''))).toEqual({ status: 'open', mine: false });
    expect(proposalFilterFromParams(new URLSearchParams('status=all&space=x&mine=1'))).toEqual({ status: 'all', space: 'x', mine: true });
    expect(proposalFilterFromParams(new URLSearchParams('status=evil')).status).toBe('open');
  });

  it('explains obvious refusals: decided, own, human-only for a non-human', () => {
    const me = { name: 'alice', kind: 'human' };
    expect(acceptBlocker(prop(), me)).toBeNull();
    expect(acceptBlocker(prop({ status: 'accepted' }), me)).toMatch(/already been decided/);
    expect(acceptBlocker(prop({ author: { name: 'alice', kind: 'human', trust: 'admin' } }), me)).toMatch(/your own proposal/);
    expect(acceptBlocker(prop({ human_required: true }), me)).toBeNull();
    expect(acceptBlocker(prop({ human_required: true }), { name: 'alice-assistant', kind: 'agent' })).toMatch(/only a person/);
  });

  it('staleHead reads the current head only from a conflict', () => {
    const cur = { rev: 7, content_hash: 'x', author: { name: 'a', kind: 'agent', trust: 'trusted' }, updated_at: '' };
    expect(staleHead(new ApiError(409, { code: 'conflict', message: '', retryable: false, details: { reason: 'stale_proposal', current: cur } }))?.rev).toBe(7);
    expect(staleHead(new ApiError(409, { code: 'conflict', message: '', retryable: false, details: { reason: 'stale_proposal' } }))).toBeNull();
    expect(staleHead(new ApiError(403, { code: 'forbidden', message: '', retryable: false }))).toBeNull();
    expect(staleHead(new Error('x'))).toBeNull();
  });
});

describe('audit', () => {
  it('filter round-trips through the address', () => {
    const f = auditFilterFromParams(new URLSearchParams('principal=alphabot&op=read&evil=1&since=2026-11-01T00:00:00.000Z'));
    expect(f).toEqual({ principal: 'alphabot', op: 'read', since: '2026-11-01T00:00:00.000Z' });
    expect(auditParams(f).toString()).toBe('principal=alphabot&op=read&since=2026-11-01T00%3A00%3A00.000Z');
  });

  it('local time ↔ ISO', () => {
    expect(localToIso('')).toBeUndefined();
    expect(localToIso('nonsense')).toBeUndefined();
    const iso = localToIso('2026-11-01T09:30')!;
    expect(isoToLocal(iso)).toBe('2026-11-01T09:30');
    expect(isoToLocal(undefined)).toBe('');
  });

  it('detail text and outcome tone', () => {
    const e = { detail: { query: 'plan', results: 3, list: [1] } } as unknown as AuditEntry;
    expect(auditDetailText(e)).toBe('query: plan · results: 3 · list: [1]');
    expect(auditDetailText({ detail: null } as AuditEntry)).toBe('');
    expect(outcomeTone('ok')).toBe('ok');
    expect(outcomeTone('not_found')).toBe('danger');
    expect(outcomeTone('conflict')).toBe('warn');
  });
});
