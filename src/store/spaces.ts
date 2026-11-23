import type { Db } from '../db/open.js';
import type { SpaceRow } from './types.js';

// A row with `alias_of` is an alias (a re-homed inbox space). It is never listed;
// lookups by its slug or id return the canonical row (one hop: a canonical row is never an alias).

/** Canonical spaces of the tenant (aliases left out), by slug. */
export function listSpaces(db: Db, tenantId: string): SpaceRow[] {
  return db.prepare('SELECT * FROM spaces WHERE tenant_id = ? AND alias_of IS NULL ORDER BY slug').all(tenantId) as SpaceRow[];
}

/** Alias rows of the tenant (old slug and id → `alias_of`). */
export function listSpaceAliases(db: Db, tenantId: string): SpaceRow[] {
  return db.prepare('SELECT * FROM spaces WHERE tenant_id = ? AND alias_of IS NOT NULL ORDER BY slug').all(tenantId) as SpaceRow[];
}

const canonical = (db: Db, row: SpaceRow | undefined): SpaceRow | undefined =>
  row && row.alias_of ? (db.prepare('SELECT * FROM spaces WHERE id = ?').get(row.alias_of) as SpaceRow | undefined) : row;

/** The space with this slug; an alias slug gives its canonical space. */
export function getSpaceBySlug(db: Db, tenantId: string, slug: string): SpaceRow | undefined {
  return canonical(db, db.prepare('SELECT * FROM spaces WHERE tenant_id = ? AND slug = ?').get(tenantId, slug) as SpaceRow | undefined);
}

/** The space with this id; an alias id gives its canonical space. */
export function getSpaceById(db: Db, id: string): SpaceRow | undefined {
  return canonical(db, db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow | undefined);
}

/** The row itself, alias or not (migration only). */
export function getSpaceRowBySlug(db: Db, tenantId: string, slug: string): SpaceRow | undefined {
  return db.prepare('SELECT * FROM spaces WHERE tenant_id = ? AND slug = ?').get(tenantId, slug) as SpaceRow | undefined;
}

export function insertSpace(db: Db, row: SpaceRow): void {
  db.prepare(
    `INSERT INTO spaces (id, tenant_id, slug, name, description, review_mode, executable, inbox, ttl_days,
       trash_retention_days, quota_bytes, max_doc_bytes, protected_paths, bytes_used, archived_at,
       archived_by, created_at, created_by)
     VALUES (@id, @tenant_id, @slug, @name, @description, @review_mode, @executable, @inbox, @ttl_days,
       @trash_retention_days, @quota_bytes, @max_doc_bytes, @protected_paths, @bytes_used, @archived_at,
       @archived_by, @created_at, @created_by)`,
  ).run(row);
}

export type SpacePatch = Partial<
  Pick<
    SpaceRow,
    | 'slug'
    | 'name'
    | 'description'
    | 'review_mode'
    | 'executable'
    | 'inbox'
    | 'ttl_days'
    | 'trash_retention_days'
    | 'quota_bytes'
    | 'max_doc_bytes'
    | 'protected_paths'
    | 'archived_at'
    | 'archived_by'
  >
>;

const PATCHABLE = [
  'slug',
  'name',
  'description',
  'review_mode',
  'executable',
  'inbox',
  'ttl_days',
  'trash_retention_days',
  'quota_bytes',
  'max_doc_bytes',
  'protected_paths',
  'archived_at',
  'archived_by',
] as const;

export function updateSpace(db: Db, id: string, patch: SpacePatch): void {
  const keys = PATCHABLE.filter((k) => k in patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE spaces SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

/** `bytes_used` changes in the document write transaction. It does not affect permissions. */
export function addBytesUsed(db: Db, id: string, delta: number): void {
  if (delta !== 0) db.prepare('UPDATE spaces SET bytes_used = max(0, bytes_used + ?) WHERE id = ?').run(delta, id);
}
