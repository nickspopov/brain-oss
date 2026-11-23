// Shared editing elements: diff, write errors, the conflict screen, the write result.
import { lazy, Suspense, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client';
import type { Proposal } from '../api/types';
import { conflictText, diffLines, diffTexts, hasChanges, type Conflict } from '../lib/edit';
import { formatSize, formatTime } from '../lib/format';
import { routes } from '../lib/routes';
import { AuthorLine, errorText } from './ui';
import { tx } from '../i18n';

/** CodeMirror as a separate chunk: viewing and search don't load it. */
const LazyCodeEditor = lazy(() => import('./CodeEditor'));

export function Editor(props: { value: string; onChange: (v: string) => void; label: string; onSave?: () => void }) {
  return (
    <Suspense fallback={<div className="min-h-[50vh] rounded-md border border-zinc-300 p-3 text-sm text-zinc-500 dark:border-zinc-700">{tx.editor.loading}</div>}>
      <LazyCodeEditor {...props} />
    </Suspense>
  );
}

const LINE_CLASS = {
  add: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
  del: 'bg-red-50 text-red-900 dark:bg-red-950/60 dark:text-red-200',
  hunk: 'bg-sky-50 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  meta: 'text-zinc-500',
  ctx: '',
} as const;

/** Line-by-line unified diff with highlighting. Text only: document content never becomes HTML. */
export function DiffView({ diff, label }: { diff: string; label: string }) {
  if (!hasChanges(diff)) return <p className="text-sm text-zinc-500">{tx.editor.noDifferences}</p>;
  return (
    <pre aria-label={label} className="overflow-x-auto rounded-md border border-zinc-200 font-mono text-xs leading-5 dark:border-zinc-800">
      {diffLines(diff).map((l, i) => (
        <div key={i} data-kind={l.kind} className={`px-2 whitespace-pre-wrap break-words ${LINE_CLASS[l.kind]}`}>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

/** A write error with details that help fix the input. */
export function WriteError({ error }: { error: unknown }) {
  let text = errorText(error);
  let extra: ReactNode = null;
  if (error instanceof ApiError) {
    const d = error.details ?? {};
    switch (error.code) {
      case 'secret_detected': {
        text = tx.editor.secret;
        const findings = Array.isArray(d.findings) ? (d.findings as { rule: string; line: number; column: number }[]) : [];
        extra = findings.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {findings.map((f, i) => (
              <li key={i}>
                {tx.editor.secretAt(f.rule, f.line, f.column)}
              </li>
            ))}
          </ul>
        );
        break;
      }
      case 'too_large':
        text = tx.editor.tooLarge(typeof d.limit === 'number' ? formatSize(d.limit) : null);
        break;
      case 'quota_exceeded':
        text = tx.editor.quota;
        break;
      case 'invalid_input': {
        text = tx.editor.invalidInput;
        const issues = Array.isArray(d.issues) ? (d.issues as { path: string; message: string }[]) : [];
        extra = issues.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {issues.map((s, i) => (
              <li key={i}>
                {s.path ? `${s.path}: ` : ''}
                {s.message}
              </li>
            ))}
          </ul>
        );
        break;
      }
      case 'conflict':
        text = conflictText(typeof d.reason === 'string' ? d.reason : 'conflict');
        break;
      case 'unsupported':
        text = d.reason === 'kind_mismatch' ? tx.editor.kindMismatch : text;
        break;
    }
  }
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {text}
      {extra}
    </div>
  );
}

/** The write went into a proposal: that's a success, but the document hasn't changed yet. */
export function ProposedNote({ proposal }: { proposal: Proposal }) {
  return (
    <div role="status" className="rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
      {tx.editor.proposalSaved}{' '}
      <Link to={routes.proposal(proposal.id)} className="font-medium underline">
        {tx.editor.openProposal} <span className="font-mono">{proposal.id}</span>
      </Link>
    </div>
  );
}

const btn = 'rounded-md border px-3 py-1.5 text-sm';
export const BTN = `${btn} border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800`;
export const BTN_PRIMARY = `${btn} border-sky-700 bg-sky-700 text-white hover:bg-sky-800 disabled:opacity-50`;
export const BTN_DANGER = `${btn} border-red-700 bg-red-700 text-white hover:bg-red-800 disabled:opacity-50`;

/**
 * Conflict screen: my version, the current version and the diff between them. There is no auto-merge
 * and no "force": the human either takes the current version or continues their edit on top of the
 * current revision and saves it deliberately.
 */
export function ConflictView({
  conflict,
  mine,
  docPath,
  onTakeCurrent,
  onKeepMine,
  onCancel,
}: {
  conflict: Conflict;
  mine: string;
  docPath?: string | undefined;
  onTakeCurrent?: (() => void) | undefined;
  onKeepMine?: (() => void) | undefined;
  onCancel: () => void;
}) {
  const cur = conflict.current;
  const curText = cur?.content;
  return (
    <section aria-labelledby="conflict-h" className="space-y-4 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <header className="space-y-1">
        <h2 id="conflict-h" className="text-lg font-semibold">
          {tx.editor.conflictTitle}
        </h2>
        <p className="text-sm">{conflictText(conflict.reason)}</p>
        {cur && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {tx.editor.nowRevision(cur.rev)} <AuthorLine author={cur.author} />, {formatTime(cur.updated_at)}
          </p>
        )}
      </header>

      {cur && curText !== undefined && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">{tx.editor.diffCurrentMine}</h3>
          <DiffView diff={diffTexts(tx.editor.currentRev(cur.rev), curText, tx.editor.mine, mine)} label={tx.editor.diffCurrentMineLabel} />
        </div>
      )}
      {cur?.content_truncated && <p className="text-sm">{tx.editor.currentTooLarge}</p>}

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-semibold">{tx.editor.myVersion}</h3>
          <pre aria-label={tx.editor.myVersion} className="max-h-80 overflow-auto rounded-md bg-white p-2 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-900">
            {mine}
          </pre>
        </div>
        {curText !== undefined && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">{tx.editor.currentVersion}</h3>
            <pre aria-label={tx.editor.currentVersion} className="max-h-80 overflow-auto rounded-md bg-white p-2 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-900">
              {curText}
            </pre>
          </div>
        )}
      </div>

      {conflict.diff && (
        <details>
          <summary className="cursor-pointer text-sm">{tx.editor.changedSince}</summary>
          <div className="mt-2">
            <DiffView diff={conflict.diff} label={tx.editor.changedSinceLabel} />
          </div>
        </details>
      )}

      {conflict.diff_truncated && (
        <p className="text-sm">{tx.editor.tooManyChanges}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {onKeepMine && cur && (
          <button type="button" className={BTN_PRIMARY} onClick={onKeepMine}>
            {tx.editor.keepEditing(cur.rev)}
          </button>
        )}
        {onTakeCurrent && curText !== undefined && (
          <button type="button" className={BTN} onClick={onTakeCurrent}>
            {tx.editor.takeCurrent}
          </button>
        )}
        {docPath && cur?.content_truncated && (
          <Link className={BTN} to={docPath}>
            {tx.editor.openCurrent}
          </Link>
        )}
        <button type="button" className={BTN} onClick={onCancel}>
          {tx.common.close}
        </button>
      </div>
      {onKeepMine && cur && (
        <p className="text-xs text-zinc-500">
          {tx.editor.keepEditingHint(cur.rev)}
        </p>
      )}
    </section>
  );
}
