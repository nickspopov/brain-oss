import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { Page } from '../components/controls';
import { SpaceBadges } from '../components/SpaceBadges';
import { ErrorView, Spinner } from '../components/ui';
import { routes } from '../lib/routes';
import { tx } from '../i18n';

/** Home: spaces as rows — name, description and only the exceptional rules. */
export function SpacesPage() {
  const q = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });
  const [params, setParams] = useSearchParams();
  const showArchived = params.get('archived') === '1';
  const all = q.data?.spaces ?? [];
  const archived = all.filter((s) => s.archived).length;
  const shown = showArchived ? all : all.filter((s) => !s.archived);
  return (
    <Page>
      <h1 className="text-xl font-semibold">{tx.spacesPage.title}</h1>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorView error={q.error} />}
      {q.data && shown.length === 0 && <p className="text-zinc-500">{tx.spacesPage.none}</p>}
      {archived > 0 && (
        <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={showArchived} onChange={(e) => setParams(e.target.checked ? { archived: '1' } : {}, { replace: true })} />
          {tx.spacesAdmin.showArchived(archived)}
        </label>
      )}
      {shown.length > 0 && (
        <ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {shown.map((s) => (
            <li key={s.slug}>
              <Link to={routes.space(s.slug)} className="block space-y-1 px-1 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <span className="font-medium">{s.name}</span>
                {s.description && <p className="line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">{s.description}</p>}
                <SpaceBadges space={s} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
