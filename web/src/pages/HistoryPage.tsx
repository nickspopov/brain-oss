// Document history: revisions newest first, a diff of two revisions, one-click revert
// (`revert` is a new revision with the chosen one's body; the past doesn't change).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import type { DocInfo, RevInfo, WriteOut } from '../api/types';
import { BTN, DiffView, ProposedNote, WriteError } from '../components/edit';
import { AuthorLine, Badge, ErrorView, Spinner } from '../components/ui';
import { invalidateSpace, requestIdFor } from '../lib/edit';
import { formatSize, formatTime } from '../lib/format';
import { routes } from '../lib/routes';
import { Select } from '../components/controls';
import { tx } from '../i18n';

export const REV_KIND_LABEL: Record<RevInfo['kind'], string> = {
  ...tx.historyPage.kind,
};

export function HistoryPage() {
  const params = useParams();
  const space = params.space ?? '';
  const path = params['*'] ?? '';
  const meta = useQuery({ queryKey: ['read', space, path, 'head', 'meta'], queryFn: () => api.read({ space, path, format: 'meta' }) });
  if (meta.isPending) return <Spinner />;
  if (meta.isError) return <ErrorView error={meta.error} />;
  return <History key={meta.data.doc.id} space={space} doc={meta.data.doc} />;
}

function History({ space, doc }: { space: string; doc: DocInfo }) {
  const qc = useQueryClient();
  const path = doc.path;
  const hist = useInfiniteQuery({
    queryKey: ['history', space, path],
    queryFn: ({ pageParam }) => api.history({ space, path, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor,
  });
  const revs = useMemo(() => hist.data?.pages.flatMap((p) => p.revisions) ?? [], [hist.data]);
  const isText = doc.kind === 'text';
  const [pair, setPair] = useState<{ from: number; to: number } | null>(doc.rev > 1 ? { from: doc.rev - 1, to: doc.rev } : null);
  const [result, setResult] = useState<WriteOut | null>(null);
  const idFor = useMemo(() => requestIdFor(), []);

  const diff = useQuery({
    queryKey: ['diff', space, path, pair?.from, pair?.to],
    queryFn: () => api.diff({ space, path, from: pair!.from, to: pair!.to }),
    enabled: isText && pair !== null && pair.from !== pair.to,
  });

  const revert = useMutation({
    mutationFn: (toRev: number) => {
      const input = { space, path, to_rev: toRev, expected_rev: doc.rev, message: tx.docActions.revertMessage(toRev) };
      return idFor.run(input, (request_id) => api.revert({ ...input, request_id }));
    },
    onMutate: () => setResult(null),
    onSuccess: async (res) => {
      setResult(res);
      await invalidateSpace(qc, space);
    },
    onError: () => invalidateSpace(qc, space),
  });

  return (
    <div className="max-w-[960px] px-6 py-6 space-y-4">
      <header className="space-y-1">
        <nav className="text-sm text-zinc-500">
          <Link to={routes.doc(space, path)} className="hover:underline">
            ← {doc.title || path}
          </Link>
        </nav>
        <h1 className="text-xl font-semibold">{tx.common.history}</h1>
        <p className="text-sm text-zinc-500">
          <span className="font-mono break-all">{path}</span>
          {tx.historyPage.current(doc.rev)}
        </p>
      </header>

      {revert.isError && <WriteError error={revert.error} />}
      {result?.status === 'proposed' && result.proposal && <ProposedNote proposal={result.proposal} />}
      {result?.status === 'committed' && (
        <p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {result.unchanged ? tx.historyPage.unchanged : tx.docActions.revertDone(result.doc?.rev ?? '')}
        </p>
      )}

      {isText && revs.length > 1 && (
        <section aria-labelledby="cmp-h" className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <h2 id="cmp-h" className="text-sm font-semibold">
            {tx.historyPage.compare}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <RevSelect label={tx.historyPage.revA} revs={revs} value={pair?.from} onChange={(from) => setPair((p) => ({ from, to: p?.to ?? doc.rev }))} />
            <span aria-hidden>→</span>
            <RevSelect label={tx.historyPage.revB} revs={revs} value={pair?.to} onChange={(to) => setPair((p) => ({ from: p?.from ?? 1, to }))} />
            {diff.data && (
              <span className="text-zinc-500">
                <span className="text-emerald-700 dark:text-emerald-400">+{diff.data.added}</span> <span className="text-red-700 dark:text-red-400">−{diff.data.removed}</span>
              </span>
            )}
          </div>
          {pair && pair.from === pair.to ? (
            <p className="text-sm text-zinc-500">{tx.historyPage.pickTwo}</p>
          ) : diff.isPending ? (
            <Spinner />
          ) : diff.isError ? (
            <ErrorView error={diff.error} />
          ) : (
            <>
              {diff.data.truncated && (
                <p className="text-sm text-zinc-500">
                  {diff.data.diff ? tx.historyPage.diffTruncated : tx.historyPage.diffTooBig}
                </p>
              )}
              {diff.data.diff ? <DiffView diff={diff.data.diff} label={tx.historyPage.diffLabel(pair?.from, pair?.to)} /> : null}
            </>
          )}
        </section>
      )}

      {hist.isPending ? (
        <Spinner />
      ) : hist.isError ? (
        <ErrorView error={hist.error} />
      ) : (
        <ol aria-label={tx.historyPage.revisions} className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {revs.map((r) => (
            <li key={r.rev} className="space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">rev {r.rev}</span>
                <Badge>{REV_KIND_LABEL[r.kind] ?? r.kind}</Badge>
                {r.rev === doc.rev && <Badge tone="ok">{tx.historyPage.currentBadge}</Badge>}
                {r.ref_rev !== undefined && <span className="text-zinc-500">{tx.historyPage.toRev(r.ref_rev)}</span>}
                {r.purged && <Badge tone="danger">{tx.historyPage.purged}</Badge>}
                {r.attention && <Badge tone="warn">{tx.common.attention}</Badge>}
                <span className="text-zinc-500">{formatTime(r.created_at)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <AuthorLine author={r.author} />
                {r.approved_by && (
                  <span className="text-zinc-500">
                    {tx.historyPage.approvedBy}
                    <AuthorLine author={r.approved_by} />
                  </span>
                )}
                <span className="text-zinc-500">
                  {tx.historyPage.via(r.via, formatSize(r.size))}
                </span>
              </div>
              {r.prev_path && r.path && r.prev_path !== r.path && (
                <div className="font-mono text-xs break-all text-zinc-500">
                  {r.prev_path} → {r.path}
                </div>
              )}
              {r.message && <div className="break-words">{r.message}</div>}
              <div className="flex flex-wrap gap-2 pt-1">
                {!r.purged && (
                  <Link className={BTN} to={routes.doc(space, path, r.rev)}>
                    {tx.common.open}
                  </Link>
                )}
                {isText && r.rev > 1 && (
                  <button type="button" className={BTN} onClick={() => setPair({ from: r.rev - 1, to: r.rev })}>
                    {tx.historyPage.whatChanged}
                  </button>
                )}
                {r.rev !== doc.rev && !r.purged && (
                  <button type="button" className={BTN} disabled={revert.isPending} onClick={() => revert.mutate(r.rev)}>
                    {tx.historyPage.revertTo(r.rev)}
                  </button>
                )}
              </div>
            </li>
          ))}
          {hist.hasNextPage && (
            <li className="p-2">
              <button type="button" className={BTN} disabled={hist.isFetchingNextPage} onClick={() => void hist.fetchNextPage()}>
                {tx.historyPage.more}
              </button>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

function RevSelect({ label, revs, value, onChange }: { label: string; revs: RevInfo[]; value: number | undefined; onChange: (rev: number) => void }) {
  return (
    <label className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      <Select
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        >
        {revs
          .filter((r) => !r.purged)
          .map((r) => (
            <option key={r.rev} value={r.rev}>
              rev {r.rev} · {REV_KIND_LABEL[r.kind] ?? r.kind}
            </option>
          ))}
      </Select>
    </label>
  );
}
