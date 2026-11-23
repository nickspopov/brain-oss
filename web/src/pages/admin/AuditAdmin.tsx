// Audit view (`admin_audit_query`): who, when, through what, which operation and how it
// ended. Only for the admin capability (the route checks it in App). The audit holds no content and no tokens.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { admin } from '../../api/client';
import type { AuditFilter } from '../../api/types';
import { AdminFrame, Field, INPUT } from '../../components/admin';
import { BTN, BTN_PRIMARY } from '../../components/edit';
import { Badge, ErrorView, Spinner } from '../../components/ui';
import { auditDetailText, auditFilterFromParams, auditParams, isoToLocal, localToIso, outcomeTone } from '../../lib/feed';
import { formatTime } from '../../lib/format';
import { tx } from '../../i18n';

const TEXT_FIELDS: [keyof AuditFilter, string, string][] = [
  ['principal', tx.audit.who, tx.audit.whoPlaceholder],
  ['op', tx.audit.op, 'read, write, admin_token_issue…'],
  ['outcome', tx.audit.outcome, 'ok, not_found, forbidden…'],
  ['space', tx.common.space, 'slug'],
  ['doc_id', tx.audit.document, 'id'],
];

export function AuditAdminPage() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => auditFilterFromParams(params), [params]);
  return (
    <AdminFrame title={tx.audit.title}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {tx.audit.intro}
      </p>
      <AuditFilters key={params.toString()} filter={filter} onApply={(f) => setParams(auditParams(f), { replace: true })} />
      <AuditList filter={filter} />
    </AdminFrame>
  );
}

function AuditFilters({ filter, onApply }: { filter: AuditFilter; onApply: (f: AuditFilter) => void }) {
  const [form, setForm] = useState({ ...filter, since: isoToLocal(filter.since), until: isoToLocal(filter.until) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const f: AuditFilter = {};
    for (const [k] of TEXT_FIELDS) {
      const v = form[k]?.trim();
      if (v) f[k] = v;
    }
    const since = localToIso(form.since ?? '');
    const until = localToIso(form.until ?? '');
    if (since) f.since = since;
    if (until) f.until = until;
    onApply(f);
  };
  return (
    <form onSubmit={submit} aria-label={tx.audit.filters} className="grid gap-3 rounded-lg border border-zinc-200 p-3 sm:grid-cols-3 dark:border-zinc-800">
      {TEXT_FIELDS.map(([k, label, ph]) => (
        <Field key={k} id={`audit-${k}`} label={label}>
          <input
            id={`audit-${k}`}
            className={INPUT}
            value={form[k] ?? ''}
            placeholder={ph}
            maxLength={64}
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          />
        </Field>
      ))}
      <Field id="audit-since" label={tx.audit.since}>
        <input id="audit-since" type="datetime-local" className={INPUT} value={form.since ?? ''} onChange={(e) => setForm({ ...form, since: e.target.value })} />
      </Field>
      <Field id="audit-until" label={tx.audit.until}>
        <input id="audit-until" type="datetime-local" className={INPUT} value={form.until ?? ''} onChange={(e) => setForm({ ...form, until: e.target.value })} />
      </Field>
      <div className="flex items-end gap-2 sm:col-span-3">
        <button type="submit" className={BTN_PRIMARY}>
          {tx.common.find}
        </button>
        <button type="button" className={BTN} onClick={() => onApply({})}>
          {tx.common.reset}
        </button>
      </div>
    </form>
  );
}

function AuditList({ filter }: { filter: AuditFilter }) {
  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit', filter],
    queryFn: ({ pageParam }) => admin.auditQuery({ ...filter, ...(pageParam ? { cursor: pageParam } : {}), limit: 100 }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor,
  });
  const entries = useMemo(() => q.data?.pages.flatMap((p) => p.entries) ?? [], [q.data]);
  const [, setParams] = useSearchParams();
  const narrow = (patch: AuditFilter) => setParams(auditParams({ ...filter, ...patch }), { replace: true });

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  return (
    <section aria-label={tx.audit.entries} className="space-y-2">
      {entries.length === 0 && <p className="text-sm text-zinc-500">{tx.audit.none}</p>}
      <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        {entries.map((e) => (
          <li key={e.id} className="space-y-1 p-2.5" data-testid="audit-entry">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <time dateTime={e.ts} className="text-zinc-500">
                {formatTime(e.ts)}
              </time>
              <button type="button" className="font-medium hover:underline" title={tx.audit.onlyPrincipal} onClick={() => e.principal && narrow({ principal: e.principal })}>
                {e.principal ?? tx.audit.anonymous}
              </button>
              <button type="button" className="font-mono text-xs hover:underline" title={tx.audit.onlyOp} onClick={() => narrow({ op: e.op })}>
                {e.op}
              </button>
              <Badge tone={outcomeTone(e.outcome)}>{e.outcome}</Badge>
              <span className="text-xs text-zinc-500">{e.via}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 text-xs text-zinc-600 dark:text-zinc-400">
              {e.space && (
                <button type="button" className="font-mono hover:underline" onClick={() => narrow({ space: e.space ?? undefined })}>
                  {e.space}
                </button>
              )}
              {e.doc_id && (
                <button type="button" className="font-mono hover:underline" onClick={() => narrow({ doc_id: e.doc_id ?? undefined })}>
                  {e.doc_id}
                  {e.rev !== null ? ` rev ${e.rev}` : ''}
                </button>
              )}
              {e.ip && <span>IP {e.ip}</span>}
              {e.token_id && <span className="font-mono">{tx.audit.token(e.token_id)}</span>}
            </div>
            {e.detail && <p className="text-xs break-all text-zinc-500">{auditDetailText(e)}</p>}
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <button type="button" className={BTN} disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {tx.common.showMore}
        </button>
      )}
      <p className="text-xs text-zinc-500">
        {tx.audit.retention}
        <Link to="/admin/audit">{tx.audit.allEntries}</Link>
      </p>
    </section>
  );
}
