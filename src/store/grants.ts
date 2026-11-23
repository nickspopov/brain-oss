import type { Db } from '../db/open.js';
import type { GrantRow } from './types.js';

/**
 * Atomic grant upsert: the uniqueness key depends on scope and matches one of the three partial
 * indexes. Returns the row id (the existing one if the grant was already there).
 */
export function upsertGrant(db: Db, row: GrantRow): string {
  const target =
    row.scope === 'space'
      ? "(space_id, subject_type, subject_id) WHERE scope = 'space'"
      : row.scope === 'path'
        ? "(space_id, path_prefix, subject_type, subject_id) WHERE scope = 'path'"
        : "(space_id, doc_id, subject_type, subject_id) WHERE scope = 'doc'";
  const r = db
    .prepare(
      `INSERT INTO grants (id, space_id, scope, path_prefix, doc_id, subject_type, subject_id, role,
         granted_by, granted_at)
       VALUES (@id, @space_id, @scope, @path_prefix, @doc_id, @subject_type, @subject_id, @role,
         @granted_by, @granted_at)
       ON CONFLICT ${target}
       DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at
       RETURNING id`,
    )
    .get(row) as { id: string };
  return r.id;
}

export interface GrantKey {
  space_id: string;
  scope: GrantRow['scope'];
  path_prefix: string | null;
  doc_id: string | null;
  subject_type: GrantRow['subject_type'];
  subject_id: string;
}

export function findGrant(db: Db, k: GrantKey): GrantRow | undefined {
  return db
    .prepare(
      `SELECT * FROM grants WHERE space_id = @space_id AND scope = @scope
         AND path_prefix IS @path_prefix AND doc_id IS @doc_id
         AND subject_type = @subject_type AND subject_id = @subject_id`,
    )
    .get(k) as GrantRow | undefined;
}

export function deleteGrant(db: Db, id: string): void {
  db.prepare('DELETE FROM grants WHERE id = ?').run(id);
}

/** All grants of the tenant (for the permission snapshot). */
export function listGrantsOfTenant(db: Db, tenantId: string): GrantRow[] {
  return db
    .prepare(
      `SELECT g.* FROM grants g JOIN spaces s ON s.id = g.space_id
       WHERE s.tenant_id = ? ORDER BY g.space_id, g.scope, g.path_prefix, g.doc_id, g.subject_type, g.subject_id`,
    )
    .all(tenantId) as GrantRow[];
}

export function listGrantsForSubjects(db: Db, subjects: { type: 'principal' | 'group'; id: string }[]): GrantRow[] {
  if (subjects.length === 0) return [];
  const stmt = db.prepare('SELECT * FROM grants WHERE subject_type = ? AND subject_id = ?');
  return subjects.flatMap((s) => stmt.all(s.type, s.id) as GrantRow[]);
}
