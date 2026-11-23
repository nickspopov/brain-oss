// Editing helpers: request_id for safe retries, conflict parsing,
// unified diff markup, cache reset after a write.
import type { QueryClient } from '@tanstack/react-query';
import { createTwoFilesPatch } from 'diff';
import { ApiError } from '../api/client';
import type { ConflictCurrent } from '../api/types';
import { tx } from '../i18n';

/** A random `request_id` (8–128 characters). */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'ui-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A `request_id` for a single button. */
export interface RequestIds {
  /** id for an input: the same input after a failure gets the same id, a different input gets a new one. */
  (input: unknown): string;
  /**
   * Call with the id for input `key`; after a success the id is forgotten: the next click with the same input
   * is a new intent (disable → enable → disable again), not a retry of the first.
   */
  run<T>(key: unknown, call: (requestId: string) => Promise<T>): Promise<T>;
  /** Forget the id (the intent is done). */
  reset(): void;
}

/**
 * One `request_id` per intent: retrying the same input after a network failure gets the same id, and
 * the server won't perform the action twice; a different input gets a new id. A successful response closes
 * the intent: clicking again with the same input gets a new id, otherwise the server would return the stored
 * response of the first click and do nothing.
 */
export function requestIdFor(): RequestIds {
  let last: { key: string; id: string } | null = null;
  const idFor = ((input: unknown) => {
    const key = JSON.stringify(input);
    if (last?.key !== key) last = { key, id: newRequestId() };
    return last.id;
  }) as RequestIds;
  idFor.reset = () => {
    last = null;
  };
  idFor.run = async (key, call) => {
    const id = idFor(key);
    const out = await call(id);
    if (last?.id === id) last = null;
    return out;
  };
  return idFor;
}

export interface Conflict {
  reason: string;
  current?: ConflictCurrent;
  /** The server's unified diff: from the revision the edit started on to the current one. */
  diff?: string;
  /** Diff not computed: more than 1000 lines changed since the edit started. */
  diff_truncated?: boolean;
}

/** `conflict` from an error, or `null`. */
export function asConflict(err: unknown): Conflict | null {
  if (!(err instanceof ApiError) || err.code !== 'conflict') return null;
  const d = err.details ?? {};
  const reason = typeof d.reason === 'string' ? d.reason : 'conflict';
  const cur = d.current as ConflictCurrent | undefined;
  return {
    reason,
    ...(cur && typeof cur.rev === 'number' ? { current: cur } : {}),
    ...(typeof d.diff === 'string' ? { diff: d.diff } : {}),
    ...(d.diff_truncated === true ? { diff_truncated: true } : {}),
  };
}

export const CONFLICT_TEXT: Record<string, string> = {
  ...tx.conflict,
};

export function conflictText(reason: string): string {
  return CONFLICT_TEXT[reason] ?? tx.conflictOther(reason);
}

/** A client-side "current → mine" diff: what my version will change in the current one. */
export function diffTexts(fromLabel: string, from: string, toLabel: string, to: string): string {
  return createTwoFilesPatch(fromLabel, toLabel, from, to, undefined, undefined, { context: 3 });
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

/** Unified diff lines with a kind for highlighting. Text stays text (no HTML). */
export function diffLines(diff: string): { kind: DiffLineKind; text: string }[] {
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines
    .filter((l) => !l.startsWith('====='))
    .map((text) => {
      if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('Index:') || text.startsWith('\\')) return { kind: 'meta', text };
      if (text.startsWith('@@')) return { kind: 'hunk', text };
      if (text.startsWith('+')) return { kind: 'add', text };
      if (text.startsWith('-')) return { kind: 'del', text };
      return { kind: 'ctx', text };
    });
}

/** Whether the diff has changes (not just headers). */
export function hasChanges(diff: string): boolean {
  return diffLines(diff).some((l) => l.kind === 'add' || l.kind === 'del');
}

/** After a write: everything that shows the space's documents is refetched. */
export function invalidateSpace(qc: QueryClient, space: string): Promise<void> {
  const keys = new Set(['read', 'list', 'history', 'diff', 'trash', 'search', 'spaces']);
  return qc.invalidateQueries({
    predicate: (q) => {
      const [k, s] = q.queryKey as unknown[];
      return typeof k === 'string' && keys.has(k) && (k === 'search' || k === 'spaces' || s === space);
    },
  });
}

/** The folder of a path (`a/b/c.md` → `a/b`, `c.md` → ``). */
export function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Joins a folder and a name without double or leading `/`. */
export function joinPath(folder: string, name: string): string {
  return [...folder.split('/'), ...name.split('/')].filter((s) => s !== '').join('/');
}

/** A simple path check before the request; the server does the final path validation. */
export function pathProblem(path: string): string | null {
  if (path.trim() === '') return tx.path.empty;
  if (path.startsWith('/') || path.endsWith('/')) return tx.path.slashes;
  if (path.includes('\\')) return tx.path.backslash;
  if (path.split('/').some((s) => s === '.' || s === '..' || s === '')) return tx.path.segments;
  return null;
}
