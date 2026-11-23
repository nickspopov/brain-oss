// The space's trash: deleted documents (`list` with `include_deleted`) and
// restoring them (`restore`). A taken path → `conflict path_taken`; a new one can be chosen.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, rawUrl } from '../api/client';
import type { DocInfo } from '../api/types';
import { BTN, BTN_PRIMARY, WriteError } from '../components/edit';
import { AuthorLine, ErrorView, Spinner } from '../components/ui';
import { asConflict, invalidateSpace, pathProblem, requestIdFor } from '../lib/edit';
import { formatSize, formatTime } from '../lib/format';
import { routes } from '../lib/routes';
import { tx } from '../i18n';

/** The maximum `list` depth per call; deeper levels take another call from the folder. */
const MAX_DEPTH = 5;

/** All deleted documents of the space visible to the caller. */
export async function loadTrash(space: string): Promise<DocInfo[]> {
  const out: DocInfo[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const base = queue.shift()!;
    const baseDepth = base === '' ? 0 : base.split('/').length;
    let cursor: string | undefined;
    do {
      const page = await api.list({ space, ...(base ? { path: base } : {}), depth: MAX_DEPTH, include_deleted: true, limit: 500, ...(cursor ? { cursor } : {}) });
      for (const e of page.entries) {
        if (e.type === 'doc') {
          if (e.deleted) out.push(e);
        } else if (e.path.split('/').length - baseDepth === MAX_DEPTH) {
          queue.push(e.path);
        }
      }
      cursor = page.next_cursor;
    } while (cursor);
  }
  return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

export function TrashPage() {
  const { space = '' } = useParams();
  const q = useQuery({ queryKey: ['trash', space], queryFn: () => loadTrash(space) });
  return (
    <div className="max-w-[960px] px-6 py-6 space-y-4">
      <header className="space-y-1">
        <nav className="text-sm text-zinc-500">
          <Link to={routes.space(space)} className="hover:underline">
            ← {space}
          </Link>
        </nav>
        <h1 className="text-xl font-semibold">{tx.trashPage.title}</h1>
        <p className="text-sm text-zinc-500">{tx.trashPage.intro}</p>
      </header>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorView error={q.error} />
      ) : q.data.length === 0 ? (
        <p className="text-sm text-zinc-500">{tx.trashPage.empty}</p>
      ) : (
        <ul aria-label={tx.trashPage.list} className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {q.data.map((d) => (
            <TrashItem key={d.id} space={space} doc={d} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TrashItem({ space, doc }: { space: string; doc: DocInfo }) {
  const qc = useQueryClient();
  const [newPath, setNewPath] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const idFor = useMemo(() => requestIdFor(), []);
  const restore = useMutation({
    mutationFn: (path: string | undefined) => {
      const input = { id: doc.id, ...(path ? { path } : {}), message: tx.trashPage.restoreMessage };
      return idFor.run(input, (request_id) => api.restore({ ...input, request_id }));
    },
    onSuccess: () => invalidateSpace(qc, space),
    onError: (err) => {
      if (asConflict(err)?.reason === 'path_taken' && newPath === null) setNewPath(doc.path);
    },
  });
  const restored = restore.data?.doc;

  return (
    <li className="space-y-1 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium break-all">{doc.title || doc.path}</span>
        <span className="font-mono text-xs break-all text-zinc-500">{doc.path}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-zinc-500">
        {tx.trashPage.deletedBy}
        <AuthorLine author={doc.author} /> {formatTime(doc.updated_at)} · {formatSize(doc.size)}
      </div>
      {restored ? (
        <p role="status" className="text-emerald-800 dark:text-emerald-300">
          {tx.trashPage.restored}{' '}
          <Link className="underline" to={routes.doc(space, restored.path)}>
            {restored.path}
          </Link>
        </p>
      ) : (
        <>
          {restore.isError && <WriteError error={restore.error} />}
          {newPath !== null && (
            <label className="block space-y-1">
              <span className="text-zinc-600 dark:text-zinc-400">{tx.trashPage.restoreAs}</span>
              <input
                aria-label={tx.trashPage.newPath}
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1 font-mono dark:border-zinc-700"
              />
            </label>
          )}
          {problem && <p className="text-red-700 dark:text-red-400">{problem}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={restore.isPending}
              onClick={() => {
                const p = newPath === null ? null : pathProblem(newPath);
                setProblem(p);
                if (!p) restore.mutate(newPath ?? undefined);
              }}
            >
              {tx.trashPage.restore}
            </button>
            <a className={BTN} href={rawUrl(doc.id)} download>
              {tx.common.download}
            </a>
          </div>
        </>
      )}
    </li>
  );
}
