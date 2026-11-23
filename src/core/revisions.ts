// Reading documents and history (read, list, history, diff). Documents and revisions come
// from guard already checked; the write (revert) is in documents.ts via commit.
import { boundedPatch, lineStat } from './textdiff.js';
import { readBlob } from './blobs.js';
import { sliceUtf8 } from './content.js';
import { docInfo, revInfo, type DocInfoOut, type RevInfoOut } from './docview.js';
import { notFound, OpError } from './errors.js';
import { parseText, type Heading } from './frontmatter.js';
import {
  readableAgentsMd,
  requireDoc,
  requireSpace,
  revisionOf,
  revisionsOf,
  visibleDocsIn,
  type AccessContext,
  type DocAccess,
  type DocRefInput,
} from './guard.js';
import { noteFullRead } from './documents.js';
import { normalizePath, pathKey } from './paths.js';
import { openCursor, sealCursor } from './cursor.js';
import type { SpaceRow } from '../store/types.js';

/** By `id` a deleted document is found too (history, restore); by path only a live one. */
function docFor(ctx: AccessContext, ref: DocRefInput): DocAccess {
  return requireDoc(ctx, ref, 'read', { includeDeleted: ref.id !== undefined });
}

// --- Cursors -----------------------------------------------------------------------------------
// An opaque string encrypted with the server key and bound to the caller and the parameters
// (core/cursor.ts). Values are a revision number and an offset in the already filtered listing.

// --- read --------------------------------------------------------------------------------------

export interface ReadInput {
  ref: DocRefInput;
  rev?: number | undefined;
  format: 'full' | 'outline' | 'meta';
  offset: number;
  maxBytes: number;
}

export interface ReadOut {
  doc: DocInfoOut;
  revision: RevInfoOut;
  content?: string;
  encoding: 'utf8' | 'base64';
  truncated: boolean;
  next_offset?: number;
  outline?: Heading[];
}

/** `read`: the head or revision `rev`; a full read of the head counts towards read_count. */
export function readDocument(ctx: AccessContext, input: ReadInput): ReadOut {
  const access = docFor(ctx, input.ref);
  const rev = input.rev ?? access.doc.head_rev;
  const revision = revisionOf(ctx, access, rev);
  const encoding = access.doc.kind === 'text' ? 'utf8' : 'base64';
  const base: ReadOut = { doc: docInfo(ctx, access.doc), revision: revInfo(revision), encoding, truncated: false };
  if (input.format === 'meta') return base;
  if (revision.purged_at !== null) throw new OpError('purged', { rev });
  const body = readBlob(ctx.core, revision.content_hash, access.doc.kind);
  if (!body) throw new Error('revision body is missing');
  if (input.format === 'outline') {
    return body.kind === 'text' ? { ...base, outline: parseText(body.text, access.doc.path).headings } : { ...base, outline: [] };
  }
  let out: ReadOut;
  if (body.kind === 'text') {
    const part = sliceUtf8(body.text, input.offset, input.maxBytes);
    out = { ...base, content: part.text, truncated: part.next !== undefined, ...(part.next !== undefined ? { next_offset: part.next } : {}) };
  } else {
    const start = Math.min(input.offset, body.bytes.length);
    const end = Math.min(start + input.maxBytes, body.bytes.length);
    out = {
      ...base,
      content: body.bytes.subarray(start, end).toString('base64'),
      truncated: end < body.bytes.length,
      ...(end < body.bytes.length ? { next_offset: end } : {}),
    };
  }
  if (rev === access.doc.head_rev && input.offset === 0 && !out.truncated && access.doc.deleted_at === null) {
    noteFullRead(ctx, access);
  }
  return out;
}

// --- raw ----------------------------------------------------------------------------------------

export interface RawBody {
  doc_id: string;
  bytes: Buffer;
  /** MIME of the document; served only as an attachment with nosniff. */
  mime: string;
  /** File name for Content-Disposition (the last path segment). */
  filename: string;
  rev: number;
}

/** `GET /api/v1/docs/{id}/raw?rev=`: the body as is; permissions and purging as for `read`. */
export function rawBody(ctx: AccessContext, id: string, rev: number | undefined): RawBody {
  const access = docFor(ctx, { id });
  const r = rev ?? access.doc.head_rev;
  const revision = revisionOf(ctx, access, r);
  if (revision.purged_at !== null) throw new OpError('purged', { rev: r });
  const body = readBlob(ctx.core, revision.content_hash, access.doc.kind);
  if (!body) throw new Error('revision body is missing');
  if (r === access.doc.head_rev && access.doc.deleted_at === null) noteFullRead(ctx, access);
  const name = access.doc.path.split('/').pop() ?? 'document';
  return {
    doc_id: access.doc.id,
    bytes: body.kind === 'text' ? Buffer.from(body.text, 'utf8') : body.bytes,
    mime: access.doc.kind === 'text' ? `${access.doc.mime}; charset=utf-8` : access.doc.mime,
    filename: name,
    rev: r,
  };
}

// --- list --------------------------------------------------------------------------------------

export interface ListInput {
  space: string;
  path?: string | undefined;
  depth: number;
  includeDeleted: boolean;
  /** False leaves out messages (the UI tree; messages live in the Inbox). */
  includeMessages?: boolean;
  cursor?: string | undefined;
  limit: number;
}

export type ListEntry = { type: 'folder'; path: string; children: number } | ({ type: 'doc' } & DocInfoOut);

/**
 * `list`: documents with role ≥ read; a folder exists if it contains at least one visible
 * document; the child counter counts only what is visible. Folders, then documents, by path_key.
 */
export function listDocuments(ctx: AccessContext, input: ListInput): { entries: ListEntry[]; next_cursor?: string } {
  const { space } = requireSpace(ctx, input.space, 'read');
  const base = input.path === undefined || input.path === '' ? null : normalizePath(input.path.replace(/\/+$/, ''));
  const baseSegs = base === null ? 0 : base.split('/').length;
  const prefixKey = base === null ? '' : pathKey(base) + '/';
  let docs = visibleDocsIn(ctx, space, prefixKey, input.includeDeleted);
  if (input.includeMessages === false) {
    const messages = new Set(
      (ctx.core.db.prepare('SELECT m.doc_id FROM handoff_messages m JOIN documents d ON d.id = m.doc_id WHERE d.space_id = ?').all(space.id) as { doc_id: string }[]).map((r) => r.doc_id),
    );
    if (messages.size > 0) docs = docs.filter((d) => !messages.has(d.id));
  }
  // There are no empty folders: a folder without visible documents is indistinguishable from a missing one.
  if (base !== null && docs.length === 0) throw notFound();

  const folders = new Map<string, { path: string; children: Set<string> }>();
  const docEntries: { key: string; doc: (typeof docs)[number] }[] = [];
  const childKey = (segs: string[], level: number) => segs.slice(0, level + 1).join('/').toLowerCase();
  for (const d of docs) {
    const segs = d.path.split('/');
    const rel = segs.length - baseSegs;
    // Direct children of every folder on the document's path (for the children counter).
    for (let level = baseSegs; level < segs.length - 1; level++) {
      const key = segs.slice(0, level + 1).join('/').toLowerCase();
      let f = folders.get(key);
      if (!f) {
        f = { path: segs.slice(0, level + 1).join('/'), children: new Set() };
        folders.set(key, f);
      }
      f.children.add(level + 1 === segs.length - 1 ? `doc:${d.id}` : `dir:${childKey(segs, level + 1)}`);
    }
    if (rel <= input.depth) docEntries.push({ key: d.path_key, doc: d });
  }
  const folderEntries = [...folders.entries()]
    .filter(([key]) => key.split('/').length - baseSegs <= input.depth)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, f]) => ({ type: 'folder' as const, path: f.path, children: f.children.size }));
  docEntries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.doc.num - b.doc.num));
  const all: ListEntry[] = [...folderEntries, ...docEntries.map((e) => ({ type: 'doc' as const, ...docInfo(ctx, e.doc) }))];
  const params = { s: space.id, p: prefixKey, d: input.depth, x: input.includeDeleted, ...(input.includeMessages === false ? { m: 0 } : {}) };
  const offset = input.cursor ? openCursor(ctx, 'list', input.cursor, params) : 0;
  const page = all.slice(offset, offset + input.limit);
  const next = offset + input.limit < all.length ? sealCursor(ctx, 'list', offset + input.limit, params) : undefined;
  return { entries: page, ...(next ? { next_cursor: next } : {}) };
}

// --- history -----------------------------------------------------------------------------------

/** `history`: revisions of a document, newest first. */
export function historyOf(
  ctx: AccessContext,
  ref: DocRefInput,
  cursor: string | undefined,
  limit: number,
): { revisions: RevInfoOut[]; next_cursor?: string } {
  const access = docFor(ctx, ref);
  const before = cursor ? openCursor(ctx, 'hist', cursor, access.doc.id) : access.doc.head_rev + 1;
  const rows = revisionsOf(ctx, access, before, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    revisions: page.map(revInfo),
    ...(rows.length > limit && last ? { next_cursor: sealCursor(ctx, 'hist', last.rev, access.doc.id) } : {}),
  };
}

// --- diff --------------------------------------------------------------------------------------

/** A diff larger than this is truncated (`truncated: true`). */
const MAX_DIFF_BYTES = 256 * 1024;

export interface DiffOut {
  from: number;
  to: number;
  diff?: string;
  added: number;
  removed: number;
  truncated: boolean;
}

function textAt(ctx: AccessContext, access: DocAccess, rev: number): string {
  const r = revisionOf(ctx, access, rev);
  if (r.purged_at !== null) throw new OpError('purged', { rev });
  const b = readBlob(ctx.core, r.content_hash, 'text');
  if (!b) throw new Error('revision body is missing');
  if (b.kind !== 'text') throw new OpError('unsupported', { reason: 'not_text' });
  return b.text;
}

/** `diff` between two text revisions. `from: "seen"` was removed. */
export function diffOf(ctx: AccessContext, ref: DocRefInput, from: number, to: number | 'head', format: 'unified' | 'stat'): DiffOut {
  const access = docFor(ctx, ref);
  if (access.doc.kind !== 'text') throw new OpError('unsupported', { reason: 'not_text' });
  const toRev = to === 'head' ? access.doc.head_rev : to;
  const a = textAt(ctx, access, from);
  const b = textAt(ctx, access, toRev);
  const stat = lineStat(a, b);
  // Above the diff cap ("large diff → stat"): no text, the numbers are an estimate.
  const out: DiffOut = { from, to: toRev, added: stat.added, removed: stat.removed, truncated: !stat.exact };
  if (format === 'stat' || !stat.exact) return out;
  let patch = boundedPatch(access.doc.path, from, toRev, a, b);
  if (patch === undefined) return { ...out, truncated: true };
  if (Buffer.byteLength(patch, 'utf8') > MAX_DIFF_BYTES) {
    patch = sliceUtf8(patch, 0, MAX_DIFF_BYTES).text;
    out.truncated = true;
  }
  return { ...out, diff: patch };
}

// --- AGENTS.md -----------------------------------------------------------------------------------

/** AGENTS.md in `spaces`: at most 64 KB. */
const AGENTS_MD_MAX = 64 * 1024;

/** The space's AGENTS.md for `spaces`, only with `read` on the document itself. */
export function agentsMdOf(ctx: AccessContext, space: SpaceRow): { rev: number; content: string; truncated: boolean } | undefined {
  const doc = readableAgentsMd(ctx, space);
  if (!doc || doc.kind !== 'text') return undefined;
  const body = readBlob(ctx.core, doc.content_hash, 'text');
  if (!body || body.kind !== 'text') return undefined;
  const part = sliceUtf8(body.text, 0, AGENTS_MD_MAX);
  return { rev: doc.head_rev, content: part.text, truncated: part.next !== undefined };
}
