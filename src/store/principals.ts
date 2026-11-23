import type { Db } from '../db/open.js';
import type { PrincipalRow } from './types.js';

export function getPrincipalById(db: Db, id: string): PrincipalRow | undefined {
  return db.prepare('SELECT * FROM principals WHERE id = ?').get(id) as PrincipalRow | undefined;
}

export function getPrincipalByName(db: Db, tenantId: string, name: string): PrincipalRow | undefined {
  return db.prepare('SELECT * FROM principals WHERE tenant_id = ? AND name = ?').get(tenantId, name) as
    | PrincipalRow
    | undefined;
}

export function listPrincipals(db: Db, tenantId: string): PrincipalRow[] {
  return db.prepare('SELECT * FROM principals WHERE tenant_id = ? ORDER BY name').all(tenantId) as PrincipalRow[];
}

export function insertPrincipal(db: Db, row: PrincipalRow): void {
  db.prepare(
    `INSERT INTO principals (id, tenant_id, name, display_name, kind, role, trust, owner_id, harness,
       password_hash, start_seq, disabled_at, can_admin, external, owner_label, limits, created_at, created_by)
     VALUES (@id, @tenant_id, @name, @display_name, @kind, @role, @trust, @owner_id, @harness,
       @password_hash, @start_seq, @disabled_at, @can_admin, @external, @owner_label, @limits, @created_at, @created_by)`,
  ).run(row);
}

export type PrincipalPatch = Partial<
  Pick<
    PrincipalRow,
    'display_name' | 'trust' | 'owner_id' | 'harness' | 'password_hash' | 'disabled_at' | 'can_admin' | 'owner_label' | 'limits' | 'external' | 'what_i_do' | 'contact_notes' | 'profile_updated_at'
  >
>;

const PATCHABLE = [
  'display_name',
  'trust',
  'owner_id',
  'harness',
  'password_hash',
  'disabled_at',
  'can_admin',
  'owner_label',
  'limits',
  'external',
  'what_i_do',
  'contact_notes',
  'profile_updated_at',
] as const;

export function updatePrincipal(db: Db, id: string, patch: PrincipalPatch): void {
  const keys = PATCHABLE.filter((k) => k in patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE principals SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

export function setCanAdminByName(db: Db, tenantId: string, name: string): number {
  return db
    .prepare("UPDATE principals SET can_admin = 1 WHERE tenant_id = ? AND name = ? AND kind != 'system' AND can_admin = 0")
    .run(tenantId, name).changes;
}

export function countActiveSuperadmins(db: Db, tenantId: string): number {
  const r = db
    .prepare(
      `SELECT count(*) AS n FROM principals
       WHERE tenant_id = ? AND role = 'superadmin' AND kind = 'human' AND disabled_at IS NULL`,
    )
    .get(tenantId) as { n: number };
  return r.n;
}

export function setPasswordHash(db: Db, id: string, hash: string): void {
  db.prepare("UPDATE principals SET password_hash = ? WHERE id = ? AND kind = 'human'").run(hash, id);
}

/** Current global seq: the initial `changes` cursor of a new principal. */
export function currentSeq(db: Db): number {
  const r = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'revisions'").get() as
    | { seq: number }
    | undefined;
  return r?.seq ?? 0;
}
