// Bounded line diff. jsdiff (Myers) costs O((N+M)·D): on a fully rewritten document of hundreds
// of KB that is minutes of CPU on the only thread. Here the diff is computed with a cap on edits
// and time; above the cap there is no patch text, only an estimate of line counts from the common
// prefix and suffix (an upper bound), `exact: false`.
import { createTwoFilesPatch, diffLines } from 'diff';

/** Largest number of changed lines for which an exact diff is computed. */
export const DIFF_MAX_EDIT_LINES = 1000;
/** Hard time cap for a single diff (ms): a safeguard on a slow or busy machine. */
export const DIFF_TIMEOUT_MS = 150;

const LIMITS = { maxEditLength: DIFF_MAX_EDIT_LINES, timeout: DIFF_TIMEOUT_MS };

export interface LineStat {
  added: number;
  removed: number;
  /** `false`: the cap was exceeded, the numbers are an upper estimate. */
  exact: boolean;
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Estimate without a diff: lines between the common prefix and suffix. Linear. */
function roughStat(a: string, b: string): LineStat {
  const x = splitLines(a);
  const y = splitLines(b);
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return { removed: x.length - p - s, added: y.length - p - s, exact: false };
}

/** Number of added and removed lines. */
export function lineStat(a: string, b: string): LineStat {
  const parts = diffLines(a, b, LIMITS);
  if (parts === undefined) return roughStat(a, b);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed, exact: true };
}

/** Unified diff, or `undefined` if the edit or time cap is exceeded. */
export function boundedPatch(path: string, fromRev: number | string, toRev: number | string, a: string, b: string): string | undefined {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, a, b, `rev ${fromRev}`, `rev ${toRev}`, { context: 3, ...LIMITS });
}
