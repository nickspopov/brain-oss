// The change feed (`activity`): who, what, where; filters by space,
// agent and "needs attention". The filters live in the URL, so the link can be shared.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { admin as adminApi, api } from '../api/client';
import type { ChangeItem } from '../api/types';
import { BTN } from '../components/edit';
import { AuthorLine, Badge, ErrorView, Spinner } from '../components/ui';
import { activityInput, feedFilterFromParams, feedParams, groupByDay, shouldAutoLoad, visibleItems, type FeedFilter } from '../lib/feed';
import { formatTime } from '../lib/format';
import { routes } from '../lib/routes';
import { useSession } from '../session';
import { REV_KIND_LABEL } from './HistoryPage';
import { Select } from '../components/controls';
import { tx } from '../i18n';

const PAGE = 50;
/** How many matching edits to show per "more" click with the "needs attention" filter. */
const WANT_STEP = 20;
/** How many feed pages to read in a row without a click while looking for "needs attention" edits. */
const BUDGET = 10;

export function FeedPage() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => feedFilterFromParams(params), [params]);
  const apply = (f: FeedFilter) => setParams(feedParams(f), { replace: true });
  return (
    <div className="max-w-[960px] px-6 py-6 space-y-4">
      <h1 className="text-xl font-semibold">{tx.feedPage.title}</h1>
      <FeedFilters key={params.toString()} filter={filter} onApply={apply} />
      <FeedList key={`${filter.space ?? ''}|${filter.author ?? ''}|${filter.attention}`} filter={filter} />
    </div>
  );
}

function FeedFilters({ filter, onApply }: { filter: FeedFilter; onApply: (f: FeedFilter) => void }) {
  const session = useSession();
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });
  // The values are also kept locally: address changes go through React Router navigation, and a controlled field
  // bound only to the address would briefly show the previous value.
  const [local, setLocal] = useState(filter);
  const [author, setAuthor] = useState(filter.author ?? '');
  const change = (patch: Partial<FeedFilter>) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onApply(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    change({ author: author.trim() || undefined });
  };
  const admin = session.data?.admin === true;
  return (
    <form onSubmit={submit} aria-label={tx.feedPage.filters} className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="space-y-1">
        <label htmlFor="feed-space" className="block text-sm font-medium">
          {tx.common.space}
        </label>
        <Select
          id="feed-space"
          value={local.space ?? ''}
          onChange={(e) => change({ space: e.target.value || undefined })}
        >
          <option value="">{tx.feedPage.allAvailable}</option>
          {spaces.data?.spaces.filter((s) => !s.archived || s.slug === local.space).map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-40 flex-1 space-y-1">
        <label htmlFor="feed-author" className="block text-sm font-medium">
          {tx.feedPage.who}
        </label>
        <div className="flex gap-2">
          <input
            id="feed-author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder={tx.feedPage.whoPlaceholder}
            list={admin ? 'feed-authors' : undefined}
            maxLength={64}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button type="submit" className={BTN}>
            {tx.common.show}
          </button>
        </div>
        {admin && <AuthorOptions />}
      </div>
      <label className="flex items-center gap-2 py-1.5 text-sm">
        <input type="checkbox" checked={local.attention} onChange={(e) => change({ attention: e.target.checked })} />
        {tx.feedPage.attention}
      </label>
      {(filter.space || filter.author || filter.attention) && (
        <button type="button" className="py-1.5 text-sm text-sky-700 underline dark:text-sky-400" onClick={() => onApply({ attention: false })}>
          {tx.common.reset}
        </button>
      )}
    </form>
  );
}

/** Name suggestions: only an admin has the principals list; everyone else types the name themselves. */
function AuthorOptions() {
  const q = useQuery({ queryKey: ['admin', 'principals'], queryFn: () => adminApi.principalList(true) });
  return (
    <datalist id="feed-authors">
      {q.data?.principals
        .filter((p) => p.kind !== 'system')
        .map((p) => (
          <option key={p.id} value={p.name}>
            {p.display_name}
          </option>
        ))}
    </datalist>
  );
}

function FeedList({ filter }: { filter: FeedFilter }) {
  const q = useInfiniteQuery({
    queryKey: ['activity', filter.space ?? null, filter.author ?? null],
    queryFn: ({ pageParam }) => api.activity(activityInput(filter, pageParam || undefined, PAGE)),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor,
  });
  const all = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const items = useMemo(() => visibleItems(all, filter), [all, filter]);
  const [want, setWant] = useState(WANT_STEP);
  const pagesAtRound = useRef(0);
  const pages = q.data?.pages.length ?? 0;
  const { hasNextPage, isFetching, fetchNextPage } = q;

  // With "needs attention" there may be no matching edits on the first page: we keep reading ourselves,
  // but no more than BUDGET pages at a time.
  useEffect(() => {
    if (shouldAutoLoad({ attention: filter.attention, shown: items.length, want, hasNext: hasNextPage, fetching: isFetching, pagesThisRound: pages - pagesAtRound.current, budget: BUDGET })) {
      void fetchNextPage();
    }
  }, [filter.attention, items.length, want, hasNextPage, isFetching, pages, fetchNextPage]);

  const more = () => {
    pagesAtRound.current = pages;
    if (filter.attention) setWant(items.length + WANT_STEP);
    else void fetchNextPage();
  };

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  return (
    <section aria-label={tx.feedPage.changes} className="space-y-4">
      {filter.attention && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {tx.feedPage.attentionHint(all.length)}
        </p>
      )}
      {items.length === 0 && !isFetching && <p className="text-sm text-zinc-500">{filter.attention ? tx.feedPage.nothingAttention : tx.feedPage.noChanges}</p>}
      {groupByDay(items).map((g) => (
        <div key={g.day}>
          <h2 className="sticky top-0 z-10 bg-white/90 py-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase backdrop-blur dark:bg-zinc-950/90">{g.day}</h2>
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {g.items.map((it) => (
              <FeedItem key={`${it.doc.id}:${it.rev}`} it={it} />
            ))}
          </ul>
        </div>
      ))}
      {isFetching && <Spinner />}
      {hasNextPage && !isFetching && (
        <button type="button" className={BTN} onClick={more}>
          {tx.common.showMore}
        </button>
      )}
    </section>
  );
}

function FeedItem({ it }: { it: ChangeItem }) {
  const deleted = it.kind === 'delete' || it.kind === 'expire';
  return (
    <li className="space-y-1 p-3" data-testid="feed-item">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <time dateTime={it.created_at} className="text-zinc-500">
          {formatTime(it.created_at)}
        </time>
        <AuthorLine author={it.author} />
        <Badge>{REV_KIND_LABEL[it.kind] ?? it.kind}</Badge>
        {it.attention && (
          <Badge tone="warn" title={tx.feedPage.attentionTitle}>
            {tx.common.attention}
          </Badge>
        )}
        {it.approved_by && <span className="text-xs text-zinc-500">{tx.feedPage.approvedBy(it.approved_by.name)}</span>}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <Link to={routes.space(it.doc.space)} className="font-mono text-xs text-zinc-500 hover:underline">
          {it.doc.space}
        </Link>
        {deleted ? (
          <Link to={routes.trash(it.doc.space)} className="break-all font-medium hover:underline">
            {it.doc.path}
          </Link>
        ) : (
          <Link to={routes.doc(it.doc.space, it.doc.path)} className="break-all font-medium text-sky-700 hover:underline dark:text-sky-400">
            {it.doc.title || it.doc.path}
          </Link>
        )}
        <span className="text-xs text-zinc-500">rev {it.rev}</span>
        {!deleted && (
          <Link to={routes.history(it.doc.space, it.doc.path)} className="text-xs text-sky-700 hover:underline dark:text-sky-400">
            {tx.feedPage.history}
          </Link>
        )}
      </div>
      {it.kind === 'move' && it.prev_path && (
        <p className="text-xs text-zinc-500">
          {tx.feedPage.from}
          <span className="font-mono">{it.prev_path}</span>
        </p>
      )}
      {it.message && <p className="text-sm break-words text-zinc-700 dark:text-zinc-300">{it.message}</p>}
    </li>
  );
}
