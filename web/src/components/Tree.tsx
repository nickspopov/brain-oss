// The space tree (`list`): folders expand one at a time, a level is loaded on demand,
// long folders are read to the end by cursor. Only what the caller sees (the server filters).
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { api } from '../api/client';
import type { ListEntry } from '../api/types';
import { baseName } from '../lib/format';
import { routes } from '../lib/routes';
import { ErrorView } from './ui';
import { tx } from '../i18n';

interface TreeProps {
  space: string;
  /** Path of the open document: the folders on the way to it are expanded. */
  activePath?: string | undefined;
  onNavigate?: () => void;
}

export function Tree({ space, activePath, onNavigate }: TreeProps) {
  return (
    <ul role="tree" aria-label={tx.tree.label(space)} className="text-sm">
      <TreeLevel space={space} activePath={activePath} onNavigate={onNavigate} level={0} />
    </ul>
  );
}

function TreeLevel({ space, path, activePath, onNavigate, level }: TreeProps & { path?: string; level: number }) {
  const q = useInfiniteQuery({
    queryKey: ['list', space, path ?? ''],
    queryFn: ({ pageParam }) => api.list({ space, ...(path ? { path } : {}), ...(pageParam ? { cursor: pageParam } : {}), include_messages: false, limit: 200 }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor,
  });
  const pad = { paddingLeft: `${0.5 + level * 0.9}rem` };
  if (q.isPending) {
    return (
      <li role="none" className="py-1 text-zinc-500" style={pad}>
        …
      </li>
    );
  }
  if (q.isError) {
    return (
      <li role="none">
        <ErrorView error={q.error} />
      </li>
    );
  }
  const entries = q.data.pages.flatMap((p) => p.entries);
  if (entries.length === 0 && level === 0) {
    return (
      <li role="none" className="px-2 py-1 text-zinc-500">
        {tx.tree.empty}
      </li>
    );
  }
  return (
    <>
      {entries.map((e) =>
        e.type === 'folder' ? (
          <Folder key={`f:${e.path}`} space={space} entry={e} activePath={activePath} onNavigate={onNavigate} level={level} />
        ) : (
          <li key={`d:${e.id}`} role="treeitem" aria-selected={activePath === e.path}>
            <NavLink
              to={routes.doc(space, e.path)}
              onClick={onNavigate}
              title={e.title !== baseName(e.path) ? e.title : undefined}
              style={pad}
              className={({ isActive }) =>
                `flex items-center gap-1.5 rounded py-1 pr-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                  isActive ? 'bg-sky-50 font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300' : ''
                }`
              }
            >
              <span aria-hidden className="w-4 shrink-0 text-center text-zinc-400">
                {e.kind === 'file' ? '◇' : '·'}
              </span>
              <span className="truncate">{baseName(e.path)}</span>
            </NavLink>
          </li>
        ),
      )}
      {q.hasNextPage && (
        <li role="none" style={pad}>
          <button type="button" className="py-1 text-sky-700 hover:underline dark:text-sky-400" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {tx.tree.more}
          </button>
        </li>
      )}
    </>
  );
}

function Folder({
  space,
  entry,
  activePath,
  onNavigate,
  level,
}: Omit<TreeProps, 'space'> & { space: string; entry: Extract<ListEntry, { type: 'folder' }>; level: number }) {
  const onPath = activePath !== undefined && activePath.toLowerCase().startsWith(`${entry.path.toLowerCase()}/`);
  const [expanded, setOpen] = useState(onPath);
  // Navigating to a document inside a folder expands it; it can be collapsed manually afterwards.
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath, activePath]);
  return (
    <li role="treeitem" aria-expanded={expanded} aria-selected={false}>
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        style={{ paddingLeft: `${0.5 + level * 0.9}rem` }}
        className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span aria-hidden className="w-4 shrink-0 text-center text-zinc-400">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="truncate">{baseName(entry.path)}</span>
        <span className="ml-auto text-xs text-zinc-400">{entry.children}</span>
      </button>
      {expanded && (
        <ul role="group">
          <TreeLevel space={space} path={entry.path} activePath={activePath} onNavigate={onNavigate} level={level + 1} />
        </ul>
      )}
    </li>
  );
}
