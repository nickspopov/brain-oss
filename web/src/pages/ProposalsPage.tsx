// The proposal queue: a list with filters and a card with the diff and the decision.
// Designed for a phone: full-width cards, large buttons, the decision panel sticks to the bottom.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { Proposal, ProposalGetOut, SessionPrincipal } from '../api/types';
import { BTN, BTN_DANGER, BTN_PRIMARY, DiffView, WriteError } from '../components/edit';
import { AuthorLine, Badge, ErrorView, Spinner } from '../components/ui';
import { invalidateSpace, requestIdFor } from '../lib/edit';
import { acceptBlocker, PROPOSAL_STATUS_LABEL, proposalFilterFromParams, staleHead, type ProposalStatusFilter } from '../lib/feed';
import { formatSize, formatTime } from '../lib/format';
import { routes } from '../lib/routes';
import { useSession } from '../session';
import { Select } from '../components/controls';
import { tx } from '../i18n';

const STATUS_TABS: [ProposalStatusFilter, string][] = [
  ['open', tx.proposalsPage.tabs.open],
  ['accepted', tx.proposalsPage.tabs.accepted],
  ['rejected', tx.proposalsPage.tabs.rejected],
  ['withdrawn', tx.proposalsPage.tabs.withdrawn],
  ['all', tx.proposalsPage.tabs.all],
];

const STATUS_TONE: Record<Proposal['status'], 'neutral' | 'ok' | 'danger' | 'warn'> = { open: 'warn', accepted: 'ok', rejected: 'danger', withdrawn: 'neutral' };

export function ProposalsPage() {
  const [params, setParams] = useSearchParams();
  const fromUrl = proposalFilterFromParams(params);
  // A local copy of the filter: address changes go through React Router navigation, and a field bound only
  // to the address would briefly show the previous value.
  const [f, setF] = useState(fromUrl);
  const urlKey = params.toString();
  const [seenKey, setSeenKey] = useState(urlKey);
  if (seenKey !== urlKey) {
    setSeenKey(urlKey);
    setF(fromUrl);
  }
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });
  const set = (patch: Partial<typeof f>) => {
    const n = { ...f, ...patch };
    setF(n);
    const p = new URLSearchParams();
    if (n.status !== 'open') p.set('status', n.status);
    if (n.space) p.set('space', n.space);
    if (n.mine) p.set('mine', '1');
    setParams(p, { replace: true });
  };
  const q = useInfiniteQuery({
    queryKey: ['proposals', f.status, f.space ?? null, f.mine],
    queryFn: ({ pageParam }) =>
      api.proposalList({
        ...(f.status !== 'all' ? { status: f.status } : {}),
        ...(f.space ? { space: f.space } : {}),
        ...(f.mine ? { mine: true } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: 50,
      }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.proposals) ?? [], [q.data]);

  return (
    <div className="max-w-[960px] px-6 py-6 space-y-4">
      <h1 className="text-xl font-semibold">{tx.proposalsPage.title}</h1>
      <nav aria-label={tx.proposalsPage.statusNav} className="-mx-1 flex gap-1 overflow-x-auto pb-1">
        {STATUS_TABS.map(([s, label]) => (
          <button
            key={s}
            type="button"
            aria-pressed={f.status === s}
            onClick={() => set({ status: s })}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm ${f.status === s ? 'bg-zinc-200 font-medium dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="prop-space" className="text-sm">
          {tx.common.space}
        </label>
        <Select
          id="prop-space"
          value={f.space ?? ''}
          onChange={(e) => set({ space: e.target.value || undefined })}
        >
          <option value="">{tx.common.all}</option>
          {spaces.data?.spaces.filter((s) => !s.archived || s.slug === f.space).map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.mine} onChange={(e) => set({ mine: e.target.checked })} />
          {tx.proposalsPage.onlyMine}
        </label>
      </div>
      <p className="text-xs text-zinc-500">{tx.proposalsPage.visibility}</p>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorView error={q.error} />}
      {q.data && items.length === 0 && <p className="text-sm text-zinc-500">{f.status === 'open' ? tx.proposalsPage.queueEmpty : tx.proposalsPage.none}</p>}
      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.id}>
            <Link
              to={routes.proposal(p.id)}
              className="block space-y-1 rounded-lg border border-zinc-200 p-3 hover:border-sky-400 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={STATUS_TONE[p.status]}>{PROPOSAL_STATUS_LABEL[p.status]}</Badge>
                {p.human_required && <Badge tone="warn">{tx.proposalsPage.humanOnly}</Badge>}
                {p.base_rev === 0 && <Badge>{tx.common.newDocument}</Badge>}
                <span className="font-mono text-xs text-zinc-500">{p.space}</span>
              </div>
              <div className="font-medium break-all">{p.path}</div>
              {p.message && <div className="text-sm break-words text-zinc-700 dark:text-zinc-300">{p.message}</div>}
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <AuthorLine author={p.author} trust />
                <time dateTime={p.created_at}>{formatTime(p.created_at)}</time>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <button type="button" className={BTN} disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {tx.common.showMore}
        </button>
      )}
    </div>
  );
}

async function invalidateProposals(qc: QueryClient, p: Proposal): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['proposals'] }),
    qc.invalidateQueries({ queryKey: ['proposal', p.id] }),
    qc.invalidateQueries({ queryKey: ['activity'] }),
    invalidateSpace(qc, p.space),
  ]);
}

export function ProposalPage() {
  const { id = '' } = useParams();
  const session = useSession();
  const q = useQuery({ queryKey: ['proposal', id], queryFn: () => api.proposalGet(id) });
  if (q.isPending || session.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  if (!session.data) return null;
  return <ProposalView key={id} data={q.data} me={session.data} />;
}

function ProposalView({ data, me }: { data: ProposalGetOut; me: SessionPrincipal }) {
  const qc = useQueryClient();
  const p = data.proposal;
  const [note, setNote] = useState('');
  /** The head revision the human saw and is ready to accept on top of. */
  const [overRev, setOverRev] = useState<number | null>(null);
  const idFor = useMemo(() => requestIdFor(), []);
  const open = p.status === 'open';
  const mine = p.author.name === me.name;
  const blocker = acceptBlocker(p, me);

  // The document's head is needed to explicitly accept a stale proposal on top of it.
  const head = useQuery({
    queryKey: ['read', p.space, p.doc_id ?? '', 'head', 'meta', 'proposal'],
    queryFn: () => api.read({ id: p.doc_id!, format: 'meta' }),
    enabled: open && data.stale && p.doc_id !== undefined,
  });
  const headRev = head.data?.doc.rev;

  const decide = useMutation({
    mutationFn: (input: { decision: 'accept' | 'reject'; expected_rev?: number }) => {
      const body = { id: p.id, ...input, ...(note.trim() ? { note: note.trim() } : {}) };
      return idFor.run(body, (request_id) => api.proposalDecide({ ...body, request_id }));
    },
    onSuccess: async () => {
      setOverRev(null);
      await invalidateProposals(qc, p);
    },
    onError: async (err) => {
      // The head moved on: show a fresh diff and offer to accept on top of the new revision.
      const cur = staleHead(err);
      if (cur) {
        setOverRev(cur.rev);
        await qc.invalidateQueries({ queryKey: ['proposal', p.id] });
      }
    },
  });
  const withdraw = useMutation({
    mutationFn: () => {
      const body = { id: p.id };
      return idFor.run({ ...body, withdraw: true }, (request_id) => api.proposalWithdraw({ ...body, request_id }));
    },
    onSuccess: () => invalidateProposals(qc, p),
  });

  const staleRev = overRev ?? (data.stale ? headRev : undefined);
  const busy = decide.isPending || withdraw.isPending;

  return (
    <div className="max-w-[960px] space-y-4 px-6 py-6 pb-28 md:pb-6">
      <p className="text-sm">
        <Link to={routes.proposals()} className="text-sky-700 hover:underline dark:text-sky-400">
          {tx.proposalsPage.back}
        </Link>
      </p>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[p.status]}>{PROPOSAL_STATUS_LABEL[p.status]}</Badge>
          {p.human_required && (
            <Badge tone="warn" title={tx.proposalsPage.humanRequiredTitle}>
              {tx.proposalsPage.humanRequired}
            </Badge>
          )}
          {p.base_rev === 0 ? <Badge>{tx.common.newDocument}</Badge> : <Badge>{tx.proposalsPage.basedOn(p.base_rev)}</Badge>}
        </div>
        <h1 className="text-lg font-semibold break-all">
          <Link to={routes.space(p.space)} className="font-mono text-sm font-normal text-zinc-500 hover:underline">
            {p.space}
          </Link>{' '}
          {p.doc_id ? (
            <Link to={routes.doc(p.space, p.path)} className="hover:underline">
              {p.path}
            </Link>
          ) : (
            p.path
          )}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <AuthorLine author={p.author} trust />
          <time dateTime={p.created_at} className="text-zinc-500">
            {formatTime(p.created_at)}
          </time>
          <span className="text-zinc-500">{formatSize(p.size)}</span>
        </div>
        {p.message && <p className="break-words">{p.message}</p>}
        {p.decided_by && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {tx.proposalsPage.decision}
            <AuthorLine author={p.decided_by} trust />
            {p.decided_at && <> · {formatTime(p.decided_at)}</>}
            {p.result_rev !== undefined && <>{tx.proposalsPage.resultRev(p.result_rev)}</>}
            {p.decision_note && <span className="block">{tx.proposalsPage.comment(p.decision_note)}</span>}
          </p>
        )}
      </header>

      {open && (data.stale || overRev !== null) && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {tx.proposalsPage.stale(staleRev, p.base_rev)}
        </div>
      )}

      <section aria-labelledby="prop-diff" className="space-y-2">
        <h2 id="prop-diff" className="text-sm font-semibold">
          {p.doc_id ? tx.proposalsPage.diffTitle : tx.proposalsPage.newDocText}
        </h2>
        {data.diff_truncated ? (
          <p className="text-sm text-zinc-500">{tx.proposalsPage.diffTooBig}</p>
        ) : (
          <DiffView diff={data.diff} label={tx.proposalsPage.diffLabel} />
        )}
        <details>
          <summary className="cursor-pointer text-sm">{tx.proposalsPage.fullText}</summary>
          <pre aria-label={tx.proposalsPage.proposedText} className="mt-2 max-h-[60vh] overflow-auto rounded-md border border-zinc-200 p-2 font-mono text-xs whitespace-pre-wrap dark:border-zinc-800">
            {data.content}
          </pre>
        </details>
        <p className="text-xs text-zinc-500">{tx.proposalsPage.dataNotInstruction}</p>
      </section>

      {decide.isError && !staleHead(decide.error) && <WriteError error={decide.error} />}
      {withdraw.isError && <WriteError error={withdraw.error} />}
      {decide.isSuccess && (
        <p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {decide.data.proposal.status === 'accepted' ? tx.proposalsPage.accepted(decide.data.doc?.rev ?? decide.data.proposal.result_rev ?? '') : tx.proposalsPage.rejected}
        </p>
      )}

      {open && (
        <section
          aria-label={tx.proposalsPage.decisionGroup}
          className="fixed inset-x-0 bottom-0 z-10 space-y-2 border-t border-zinc-200 bg-white/95 p-3 backdrop-blur md:static md:rounded-lg md:border md:p-3 dark:border-zinc-800 dark:bg-zinc-950/95"
        >
          {mine ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">{tx.proposalsPage.yours}</span>
              <button type="button" className={BTN} disabled={busy} onClick={() => withdraw.mutate()}>
                {tx.proposalsPage.withdraw}
              </button>
            </div>
          ) : (
            <>
              <label htmlFor="prop-note" className="sr-only">
                {tx.proposalsPage.commentToAuthor}
              </label>
              <input
                id="prop-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder={tx.proposalsPage.commentPlaceholder}
                className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              {blocker && <p className="text-sm text-zinc-600 dark:text-zinc-400">{blocker}</p>}
              <div className="flex gap-2">
                {staleRev !== undefined ? (
                  <button type="button" className={`${BTN_PRIMARY} flex-1 py-2.5 md:flex-none`} disabled={busy || blocker !== null} onClick={() => decide.mutate({ decision: 'accept', expected_rev: staleRev })}>
                    {tx.proposalsPage.acceptOver(staleRev)}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${BTN_PRIMARY} flex-1 py-2.5 md:flex-none`}
                    disabled={busy || blocker !== null || (data.stale && p.doc_id !== undefined && head.isPending)}
                    onClick={() => decide.mutate({ decision: 'accept' })}
                  >
                    {tx.proposalsPage.accept}
                  </button>
                )}
                <button type="button" className={`${BTN_DANGER} flex-1 py-2.5 md:flex-none`} disabled={busy} onClick={() => decide.mutate({ decision: 'reject' })}>
                  {tx.proposalsPage.reject}
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
