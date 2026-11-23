// Document actions: edit, history, move within the space,
// delete to the trash, revert to the open revision, upload a new version of a file.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import type { DocInfo } from '../api/types';
import { invalidateSpace, pathProblem, requestIdFor } from '../lib/edit';
import { routes } from '../lib/routes';
import { BTN, BTN_DANGER, BTN_PRIMARY, ProposedNote, WriteError } from './edit';
import { UploadForm } from './UploadForm';
import { tx } from '../i18n';

type Panel = 'move' | 'delete' | 'upload' | null;

/** A message passed along with navigation (`navigate(..., { state: { notice } })`). */
export function Notice() {
  const notice = (useLocation().state as { notice?: unknown } | null)?.notice;
  if (typeof notice !== 'string') return null;
  return (
    <p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
      {notice}
    </p>
  );
}

export function DocActions({ space, doc, viewedRev }: { space: string; doc: DocInfo; viewedRev: number | undefined }) {
  const [panel, setPanel] = useState<Panel>(null);
  const old = viewedRev !== undefined && viewedRev !== doc.rev;
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  if (doc.deleted) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="toolbar" aria-label={tx.docActions.toolbar}>
        {old ? (
          <RevertButton space={space} doc={doc} toRev={viewedRev} />
        ) : (
          <>
            {doc.kind === 'text' && (
              <Link className={BTN_PRIMARY} to={routes.edit(space, doc.path)}>
                {tx.docActions.edit}
              </Link>
            )}
            {doc.kind === 'file' && (
              <button type="button" className={BTN} aria-expanded={panel === 'upload'} onClick={() => toggle('upload')}>
                {tx.docActions.newVersion}
              </button>
            )}
          </>
        )}
        <Link className={BTN} to={routes.history(space, doc.path)}>
          {tx.common.history}
        </Link>
        {!old && (
          <>
            <button type="button" className={BTN} aria-expanded={panel === 'move'} onClick={() => toggle('move')}>
              {tx.docActions.move}
            </button>
            <button type="button" className={BTN} aria-expanded={panel === 'delete'} onClick={() => toggle('delete')}>
              {tx.docActions.delete}
            </button>
          </>
        )}
      </div>
      {panel === 'move' && <MovePanel space={space} doc={doc} onClose={() => setPanel(null)} />}
      {panel === 'delete' && <DeletePanel space={space} doc={doc} onClose={() => setPanel(null)} />}
      {panel === 'upload' && (
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <UploadForm space={space} replace={{ path: doc.path, rev: doc.rev }} />
        </div>
      )}
    </div>
  );
}

/** One-click revert: a new revision with the body of the open one (`revert`). */
function RevertButton({ space, doc, toRev }: { space: string; doc: DocInfo; toRev: number }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const idFor = useMemo(() => requestIdFor(), []);
  const revert = useMutation({
    mutationFn: () => {
      const input = { space, path: doc.path, to_rev: toRev, expected_rev: doc.rev, message: tx.docActions.revertMessage(toRev) };
      return idFor.run(input, (request_id) => api.revert({ ...input, request_id }));
    },
    onSuccess: async (res) => {
      await invalidateSpace(qc, space);
      if (res.status === 'committed') {
        navigate(routes.doc(space, doc.path), { state: { notice: res.unchanged ? tx.docActions.revertUnchanged : tx.docActions.revertDone(res.doc?.rev ?? '') } });
      }
    },
    onError: () => invalidateSpace(qc, space),
  });
  return (
    <>
      <button type="button" className={BTN_PRIMARY} disabled={revert.isPending} onClick={() => revert.mutate()}>
        {tx.docActions.revertButton}
      </button>
      {revert.isError && (
        <div className="basis-full">
          <WriteError error={revert.error} />
        </div>
      )}
      {revert.data?.status === 'proposed' && revert.data.proposal && (
        <div className="basis-full">
          <ProposedNote proposal={revert.data.proposal} />
        </div>
      )}
    </>
  );
}

function MovePanel({ space, doc, onClose }: { space: string; doc: DocInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [to, setTo] = useState(doc.path);
  const [problem, setProblem] = useState<string | null>(null);
  const idFor = useMemo(() => requestIdFor(), []);
  const move = useMutation({
    mutationFn: (toPath: string) => {
      const input = { space, path: doc.path, to_path: toPath, expected_rev: doc.rev, message: tx.docActions.moveMessage(toPath) };
      return idFor.run(input, (request_id) => api.move({ ...input, request_id }));
    },
    onSuccess: async (res) => {
      await invalidateSpace(qc, space);
      navigate(routes.doc(space, res.doc.path), { replace: true, state: { notice: tx.docActions.moved(doc.path, res.doc.path) } });
    },
  });
  return (
    <form
      aria-label={tx.docActions.move}
      className="space-y-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
      onSubmit={(e) => {
        e.preventDefault();
        const p = pathProblem(to) ?? (to === doc.path ? tx.docActions.pathUnchanged : null);
        setProblem(p);
        if (!p) move.mutate(to);
      }}
    >
      <label className="block space-y-1">
        <span className="text-zinc-600 dark:text-zinc-400">{tx.docActions.newPathIn(space)}</span>
        <input
          aria-label={tx.docActions.newPath}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1 font-mono dark:border-zinc-700"
        />
      </label>
      {problem && <p className="text-red-700 dark:text-red-400">{problem}</p>}
      {move.isError && <WriteError error={move.error} />}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={move.isPending}>
          {tx.docActions.move}
        </button>
        <button type="button" className={BTN} onClick={onClose}>
          {tx.common.cancel}
        </button>
      </div>
    </form>
  );
}

function DeletePanel({ space, doc, onClose }: { space: string; doc: DocInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const idFor = useMemo(() => requestIdFor(), []);
  const del = useMutation({
    mutationFn: () => {
      const input = { space, path: doc.path, expected_rev: doc.rev, message: tx.docActions.deleteMessage(doc.path) };
      return idFor.run(input, (request_id) => api.delete({ ...input, request_id }));
    },
    onSuccess: async () => {
      await invalidateSpace(qc, space);
      navigate(routes.space(space), { replace: true, state: { notice: tx.docActions.deleted(doc.title || doc.path) } });
    },
  });
  return (
    <div role="group" aria-label={tx.docActions.deleteGroup} className="space-y-2 rounded-lg border border-red-200 p-3 text-sm dark:border-red-900">
      <p>{tx.docActions.deleteConfirm(doc.title || doc.path)}</p>
      {del.isError && <WriteError error={del.error} />}
      <div className="flex gap-2">
        <button type="button" className={BTN_DANGER} disabled={del.isPending} onClick={() => del.mutate()}>
          {tx.docActions.deleteToTrash}
        </button>
        <button type="button" className={BTN} onClick={onClose}>
          {tx.common.cancel}
        </button>
      </div>
    </div>
  );
}
