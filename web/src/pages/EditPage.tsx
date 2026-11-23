// Document editor: CodeMirror 6 with a preview, saving with `expected_rev`,
// the conflict screen. The same screen creates a new document (`expected_rev: 0`).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../api/client';
import type { WriteOut } from '../api/types';
import { BTN, BTN_PRIMARY, ConflictView, Editor, ProposedNote, WriteError } from '../components/edit';
import { Markdown } from '../components/Markdown';
import { ErrorView, Spinner } from '../components/ui';
import { asConflict, invalidateSpace, joinPath, pathProblem, requestIdFor, type Conflict } from '../lib/edit';
import { splitFrontmatter } from '../lib/frontmatter';
import { routes } from '../lib/routes';
import { useSession } from '../session';
import { UI_MAX_BYTES } from './DocPage';
import { tx } from '../i18n';

interface Draft {
  text: string;
  /** The revision the edit started from; 0 means a new document. */
  baseRev: number;
}

/** Editing an existing document: `/s/{space}/edit/{path…}`. */
export function EditPage() {
  const params = useParams();
  const space = params.space ?? '';
  const path = params['*'] ?? '';
  const q = useQuery({
    queryKey: ['read', space, path, 'head', 'edit'],
    queryFn: () => api.read({ space, path, format: 'full', max_bytes: UI_MAX_BYTES }),
    // While the editor is open, the base of the edit must not change by itself.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // Every time the editor opens it starts from the head, not from last time's cache.
    gcTime: 0,
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  const { doc } = q.data;
  if (doc.kind !== 'text') {
    return <Refusal space={space} path={path} text={tx.editPage.isFile} />;
  }
  if (q.data.truncated) {
    return <Refusal space={space} path={path} text={tx.editPage.tooLarge} />;
  }
  return <EditorScreen key={`${space}/${path}`} space={space} initialPath={path} initial={{ text: q.data.content ?? '', baseRev: doc.rev }} markdown={doc.mime === 'text/markdown'} />;
}

/** A new document: `/s/{space}/new?folder=` or with a ready path `?path=` (e.g. `AGENTS.md`). */
export function NewDocPage() {
  const { space = '' } = useParams();
  const [search] = useSearchParams();
  const folder = search.get('folder') ?? '';
  // For a folder the path field starts with "folder/"; a ready path is filled in as is.
  const folderPath = joinPath(folder, '');
  const initialPath = search.get('path') ?? (folderPath ? `${folderPath}/` : '');
  return <EditorScreen key={`${space}/new/${initialPath}`} space={space} initialPath={initialPath} initial={{ text: '', baseRev: 0 }} creating />;
}

function Refusal({ space, path, text }: { space: string; path: string; text: string }) {
  return (
    <div className="max-w-[720px] px-6 py-6 space-y-3">
      <p role="note" className="rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
        {text}
      </p>
      <Link className={BTN} to={routes.doc(space, path)}>
        {tx.editPage.backToDoc}
      </Link>
    </div>
  );
}

function EditorScreen({
  space,
  initialPath,
  initial,
  creating = false,
  markdown,
}: {
  space: string;
  initialPath: string;
  initial: Draft;
  creating?: boolean;
  markdown?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const session = useSession();
  const [path, setPath] = useState(initialPath);
  const [draft, setDraft] = useState<Draft>(initial);
  const [saved, setSaved] = useState(initial.text);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'text' | 'preview'>('text');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [proposed, setProposed] = useState<WriteOut['proposal'] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const idFor = useMemo(() => requestIdFor(), []);
  const dirty = draft.text !== saved || (creating && draft.text !== '');
  const isMarkdown = markdown ?? /\.md$/i.test(path);

  // An unsaved edit isn't lost when the tab is closed.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (opts: { allowSecret?: boolean }) => {
      const input = {
        space,
        path,
        content: draft.text,
        expected_rev: draft.baseRev,
        message: message.trim() || (creating ? tx.editPage.createMessage(path) : tx.editPage.editMessage(path)),
        ...(opts.allowSecret ? { allow_secret: true } : {}),
      };
      return idFor.run(input, (request_id) => api.write({ ...input, request_id }));
    },
    onSuccess: async (res) => {
      setConflict(null);
      await invalidateSpace(qc, space);
      if (res.status === 'proposed' && res.proposal) {
        setSaved(draft.text);
        setProposed(res.proposal);
        return;
      }
      setSaved(draft.text);
      const to = res.doc?.path ?? path;
      navigate(routes.doc(space, to), { state: { notice: res.unchanged ? tx.editPage.unchanged : tx.editPage.saved(res.doc?.rev ?? '') } });
    },
    onError: (err) => setConflict(asConflict(err)),
  });

  const submit = (allowSecret = false) => {
    if (save.isPending) return;
    const p = pathProblem(path);
    setProblem(p);
    if (p) return;
    setProposed(null);
    save.mutate({ allowSecret });
  };

  const secretBypass =
    save.error instanceof ApiError && save.error.code === 'secret_detected' && session.data?.kind === 'human' && session.data.role === 'superadmin';
  const backTo = creating ? routes.space(space) : routes.doc(space, initialPath);
  const { body } = isMarkdown ? splitFrontmatter(draft.text) : { body: draft.text };

  return (
    <div className="max-w-7xl space-y-3 px-6 py-6">
      <header className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-semibold">{creating ? tx.editPage.newDocument : tx.editPage.edit}</h1>
        {!creating && <span className="font-mono text-sm break-all text-zinc-500">{path}</span>}
        {!creating && <span className="text-sm text-zinc-500">{tx.editPage.fromRevision(draft.baseRev)}</span>}
        {dirty && <span className="text-sm text-amber-700 dark:text-amber-400">{tx.editPage.unsaved}</span>}
      </header>

      {creating && (
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">{tx.editPage.pathIn(space)}</span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={tx.editPage.pathPlaceholder}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 font-mono dark:border-zinc-700"
            autoFocus
          />
        </label>
      )}
      {problem && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}

      {conflict ? (
        <ConflictView
          conflict={conflict}
          mine={draft.text}
          docPath={routes.doc(space, path)}
          onKeepMine={conflict.current ? () => (setDraft((d) => ({ ...d, baseRev: conflict.current!.rev })), setConflict(null), save.reset()) : undefined}
          onTakeCurrent={
            conflict.current?.content !== undefined
              ? () => {
                  const cur = conflict.current!;
                  setDraft({ text: cur.content!, baseRev: cur.rev });
                  setSaved(cur.content!);
                  setConflict(null);
                  save.reset();
                }
              : undefined
          }
          onCancel={() => (setConflict(null), save.reset())}
        />
      ) : (
        save.isError && (
          <div className="space-y-2">
            <WriteError error={save.error} />
            {secretBypass && (
              <button type="button" className={BTN} onClick={() => submit(true)}>
                {tx.editPage.notSecret}
              </button>
            )}
          </div>
        )
      )}
      {proposed && <ProposedNote proposal={proposed} />}

      <div role="tablist" aria-label={tx.editPage.view} className="flex gap-1 lg:hidden">
        {(['text', 'preview'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1 text-sm ${tab === t ? 'bg-zinc-200 dark:bg-zinc-800' : 'text-zinc-500'}`}
          >
            {t === 'text' ? tx.editPage.text : tx.editPage.preview}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={tab === 'text' ? '' : 'hidden lg:block'}>
          <Editor value={draft.text} onChange={(text) => setDraft((d) => ({ ...d, text }))} label={tx.editPage.docText} onSave={() => submit()} />
        </div>
        <section aria-label={tx.editPage.preview} className={`min-h-[50vh] overflow-auto rounded-md border border-zinc-200 p-4 dark:border-zinc-800 ${tab === 'preview' ? '' : 'hidden lg:block'}`}>
          {isMarkdown ? <Markdown source={body} env={{ space, docPath: path }} /> : <pre className="font-mono text-sm whitespace-pre-wrap">{body}</pre>}
        </section>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="min-w-0 flex-1 space-y-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">{tx.editPage.revisionMessage}</span>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={500}
            placeholder={creating ? tx.editPage.createPlaceholder : tx.editPage.editPlaceholder}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
          />
        </label>
        <button type="submit" className={BTN_PRIMARY} disabled={save.isPending || conflict !== null}>
          {save.isPending ? tx.common.saving : tx.common.save}
        </button>
        <Link to={backTo} className={BTN}>
          {dirty ? tx.editPage.discard : tx.common.close}
        </Link>
      </form>
    </div>
  );
}
