// Document and folder paths: normalisation and path_key for grants with scope = path;
// the same functions are used for documents.
import { invalidInput } from './errors.js';

const MAX_PATH_BYTES = 512;
const MAX_DEPTH = 16;
const MAX_SEGMENT = 128;
// C0 control characters, DEL and C1.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function segmentProblem(seg: string): string | null {
  if (seg.length === 0) return 'Path segments must not be empty.';
  if ([...seg].length > MAX_SEGMENT) return `Path segment is longer than ${MAX_SEGMENT} characters.`;
  if (seg === '.' || seg === '..') return 'Path segments "." and ".." are not allowed.';
  if (CONTROL_RE.test(seg)) return 'Path must not contain control characters.';
  if (seg !== seg.trim()) return 'Path segments must not start or end with a space.';
  if (seg.endsWith('.')) return 'Path segments must not end with a dot.';
  return null;
}

/** Normalised document path: NFC, without leading and trailing `/`. Throws invalid_input. */
export function normalizePath(raw: string, field = 'path'): string {
  const p = raw.normalize('NFC');
  if (p.includes('\\')) throw invalidInput(field, 'Backslash is not allowed in paths.');
  if (p.startsWith('/') || p.endsWith('/')) throw invalidInput(field, 'Path must not start or end with "/".');
  const segs = p.split('/');
  if (segs.length > MAX_DEPTH) throw invalidInput(field, `Path is deeper than ${MAX_DEPTH} levels.`);
  for (const s of segs) {
    const problem = segmentProblem(s);
    if (problem) throw invalidInput(field, problem);
  }
  if (Buffer.byteLength(p, 'utf8') > MAX_PATH_BYTES) throw invalidInput(field, `Path is longer than ${MAX_PATH_BYTES} bytes.`);
  return p;
}

/** Case-insensitive comparison key (`path_key`). */
export function pathKey(normalized: string): string {
  return normalized.toLowerCase();
}

/**
 * Folder prefix for grants with scope = path: the normalised path with a trailing `/`
 * in path_key form (`Drafts` and `drafts/` give `drafts/`).
 */
export function folderPrefixKey(raw: string, field = 'path_prefix'): string {
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return pathKey(normalizePath(trimmed, field)) + '/';
}
