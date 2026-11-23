// Documents: SQL only, no permissions. Read by guard, written only by core/documents (commit).
import type { Db } from '../db/open.js';
import type { Kind, Trust } from './types.js';

export interface DocLocation {
  id: string;
  space_id: string;
  path: string;
  path_key: string;
  deleted_at: number | null;
}

export function getDocLocation(db: Db, id: string): DocLocation | undefined {
  return db.prepare('SELECT id, space_id, path, path_key, deleted_at FROM documents WHERE id = ?').get(id) as
    | DocLocation
    | undefined;
}

export interface DocumentRow {
  num: number;
  id: string;
  tenant_id: string;
  space_id: string;
  path: string;
  path_key: string;
  kind: 'text' | 'file';
  mime: string;
  title: string;
  meta: string;
  head_rev: number;
  head_seq: number;
  content_hash: string;
  size: number;
  attribution: string;
  trust_floor: Trust;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  deleted_at: number | null;
  deleted_by: string | null;
  expires_at: number | null;
  read_count: number;
  last_read_at: number | null;
}

/** A document together with the author and approver of its head revision (for DocInfo). */
export interface DocumentView extends DocumentRow {
  author_name: string;
  author_kind: Kind;
  author_trust: Trust;
  approver_name: string | null;
  approver_kind: Kind | null;
  approver_trust: Trust | null;
}

const VIEW = `
  SELECT d.*, a.name AS author_name, a.kind AS author_kind, r.author_trust AS author_trust,
         ap.name AS approver_name, ap.kind AS approver_kind, ap.trust AS approver_trust
  FROM documents d
  JOIN revisions r ON r.doc_id = d.id AND r.rev = d.head_rev
  JOIN principals a ON a.id = r.author_id
  LEFT JOIN principals ap ON ap.id = r.approved_by`;

export function getDocView(db: Db, id: string): DocumentView | undefined {
  return db.prepare(`${VIEW} WHERE d.id = ?`).get(id) as DocumentView | undefined;
}

export function getLiveDocViewByPathKey(db: Db, spaceId: string, pathKey: string): DocumentView | undefined {
  return db.prepare(`${VIEW} WHERE d.space_id = ? AND d.path_key = ? AND d.deleted_at IS NULL`).get(spaceId, pathKey) as
    | DocumentView
    | undefined;
}

/**
 * Documents of a space under a prefix (`path_key` ending with `/`, or the empty string for the root).
 * Deleted ones only if `includeDeleted`.
 */
export function listDocViews(db: Db, spaceId: string, prefixKey: string, includeDeleted: boolean): DocumentView[] {
  const del = includeDeleted ? '' : 'AND d.deleted_at IS NULL';
  if (prefixKey === '') {
    return db.prepare(`${VIEW} WHERE d.space_id = ? ${del} ORDER BY d.path_key, d.num`).all(spaceId) as DocumentView[];
  }
  // substr instead of LIKE: paths may contain `%` and `_`.
  return db
    .prepare(`${VIEW} WHERE d.space_id = ? AND substr(d.path_key, 1, ?) = ? ${del} ORDER BY d.path_key, d.num`)
    .all(spaceId, prefixKey.length, prefixKey) as DocumentView[];
}

export function insertDocument(db: Db, row: Omit<DocumentRow, 'num' | 'read_count' | 'last_read_at'>): void {
  db.prepare(
    `INSERT INTO documents (id, tenant_id, space_id, path, path_key, kind, mime, title, meta, head_rev, head_seq,
       content_hash, size, attribution, trust_floor, created_at, created_by, updated_at, updated_by,
       deleted_at, deleted_by, expires_at)
     VALUES (@id, @tenant_id, @space_id, @path, @path_key, @kind, @mime, @title, @meta, @head_rev, @head_seq,
       @content_hash, @size, @attribution, @trust_floor, @created_at, @created_by, @updated_at, @updated_by,
       @deleted_at, @deleted_by, @expires_at)`,
  ).run(row);
}

export type DocumentPatch = Partial<
  Pick<
    DocumentRow,
    | 'space_id'
    | 'path'
    | 'path_key'
    | 'mime'
    | 'title'
    | 'meta'
    | 'head_rev'
    | 'head_seq'
    | 'content_hash'
    | 'size'
    | 'trust_floor'
    | 'updated_at'
    | 'updated_by'
    | 'deleted_at'
    | 'deleted_by'
    | 'expires_at'
  >
>;

const PATCHABLE = new Set([
  'space_id',
  'path',
  'path_key',
  'mime',
  'title',
  'meta',
  'head_rev',
  'head_seq',
  'content_hash',
  'size',
  'trust_floor',
  'updated_at',
  'updated_by',
  'deleted_at',
  'deleted_by',
  'expires_at',
]);

export function updateDocument(db: Db, id: string, patch: DocumentPatch): void {
  const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k));
  if (keys.length === 0) return;
  db.prepare(`UPDATE documents SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
}

export function noteDocRead(db: Db, id: string, now: number): void {
  db.prepare('UPDATE documents SET read_count = read_count + 1, last_read_at = ? WHERE id = ?').run(now, id);
}

/** Whether a document with this id exists (restore import). */
export function documentIdExists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id) !== undefined;
}

/** Internal document number (FTS key). */
export function docNum(db: Db, id: string): number {
  return (db.prepare('SELECT num FROM documents WHERE id = ?').get(id) as { num: number }).num;
}
