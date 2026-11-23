// Search with highlighting: the snippet arrives as text with match positions; no HTML is built.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { SearchHit } from '../api/types';
import { AuthorLine, ErrorView, Spinner } from '../components/ui';
import { formatTime } from '../lib/format';
import { segments } from '../lib/highlight';
import { routes } from '../lib/routes';
import { Select } from '../components/controls';
import { tx } from '../i18n';

export function SearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const query = (params.get('q') ?? '').trim().slice(0, 256);
  const space = params.get('space') ?? '';
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });

  const q = useInfiniteQuery({
    queryKey: ['search', query, space],
    queryFn: ({ pageParam }) => api.search({ query, ...(space ? { spaces: [space] } : {}), ...(pageParam ? { cursor: pageParam } : {}), limit: 20 }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor,
    enabled: query !== '',
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(routes.search(draft.trim(), space || undefined));
  };

  return (
    <div className="max-w-[960px] px-6 py-6 space-y-4">
      <h1 className="text-xl font-semibold">{tx.searchPage.title}</h1>
      <form role="search" onSubmit={submit} className="flex flex-wrap gap-2">
        <label htmlFor="search-q" className="sr-only">
          {tx.searchPage.query}
        </label>
        <input
          id="search-q"
          type="search"
          value={draft}
          maxLength={256}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={tx.searchPage.placeholder}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <label htmlFor="search-space" className="sr-only">
          {tx.common.space}
        </label>
        <Select
          id="search-space"
          value={space}
          onChange={(e) => navigate(routes.search(draft.trim() || query, e.target.value || undefined))}
        >
          <option value="">{tx.searchPage.allSpaces}</option>
          {spaces.data?.spaces.filter((s) => !s.archived || s.slug === space).map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </Select>
        <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 dark:bg-sky-600 dark:hover:bg-sky-500">
          {tx.common.find}
        </button>
      </form>
      {query === '' ? (
        <p className="text-zinc-500">{tx.searchPage.enterQuery}</p>
      ) : q.isPending ? (
        <Spinner label={tx.searchPage.searching} />
      ) : q.isError ? (
        <ErrorView error={q.error} />
      ) : (
        <Results hits={q.data.pages.flatMap((p) => p.results)} />
      )}
      {q.hasNextPage && (
        <button
          type="button"
          onClick={() => void q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {q.isFetchingNextPage ? tx.common.loading : tx.searchPage.more}
        </button>
      )}
    </div>
  );
}

export function Results({ hits }: { hits: SearchHit[] }) {
  if (hits.length === 0) return <p className="text-zinc-500">{tx.searchPage.nothing}</p>;
  return (
    <ol className="space-y-3" aria-label={tx.searchPage.results}>
      {hits.map((h) => (
        <li key={h.doc.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <Link to={routes.doc(h.doc.space, h.doc.path)} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
            {h.doc.title || h.doc.path}
          </Link>
          <div className="font-mono text-xs text-zinc-500">
            {h.doc.space}/{h.doc.path}
          </div>
          {h.snippet.text && (
            <p className="mt-1.5 text-sm break-words text-zinc-700 dark:text-zinc-300">
              {segments(h.snippet.text, h.snippet.highlights).map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <AuthorLine author={h.doc.author} />
            <span>{formatTime(h.doc.updated_at)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
