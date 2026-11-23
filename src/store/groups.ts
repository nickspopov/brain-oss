import type { Db } from '../db/open.js';
import type { GroupMemberRow, GroupRow } from './types.js';

export function getGroupByName(db: Db, tenantId: string, name: string): GroupRow | undefined {
  return db.prepare('SELECT * FROM groups WHERE tenant_id = ? AND name = ?').get(tenantId, name) as
    | GroupRow
    | undefined;
}

export function getGroupById(db: Db, id: string): GroupRow | undefined {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
}

export function listGroups(db: Db, tenantId: string): GroupRow[] {
  return db.prepare('SELECT * FROM groups WHERE tenant_id = ? ORDER BY name').all(tenantId) as GroupRow[];
}

export function insertGroup(db: Db, row: GroupRow): void {
  db.prepare(
    `INSERT INTO groups (id, tenant_id, name, description, system, created_at, created_by)
     VALUES (@id, @tenant_id, @name, @description, @system, @created_at, @created_by)`,
  ).run(row);
}

export function updateGroup(db: Db, id: string, patch: { name?: string; description?: string }): void {
  if (patch.name !== undefined) db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(patch.name, id);
  if (patch.description !== undefined) db.prepare('UPDATE groups SET description = ? WHERE id = ?').run(patch.description, id);
}

/** Deletes a group: memberships go by cascade, the group's grants are deleted right here. */
export function deleteGroup(db: Db, id: string): void {
  db.prepare("DELETE FROM grants WHERE subject_type = 'group' AND subject_id = ?").run(id);
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
}

export function insertGroupMember(db: Db, row: GroupMemberRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO group_members (group_id, principal_id, added_by, added_at)
     VALUES (@group_id, @principal_id, @added_by, @added_at)`,
  ).run(row);
}

export function deleteGroupMembersExcept(db: Db, groupId: string, keep: readonly string[]): void {
  const all = db.prepare('SELECT principal_id FROM group_members WHERE group_id = ?').all(groupId) as { principal_id: string }[];
  const del = db.prepare('DELETE FROM group_members WHERE group_id = ? AND principal_id = ?');
  const set = new Set(keep);
  for (const r of all) if (!set.has(r.principal_id)) del.run(groupId, r.principal_id);
}

/** All membership rows of the tenant (for the permission snapshot). */
export function listMemberships(db: Db, tenantId: string): GroupMemberRow[] {
  return db
    .prepare(
      `SELECT m.* FROM group_members m JOIN groups g ON g.id = m.group_id
       WHERE g.tenant_id = ? ORDER BY m.group_id, m.principal_id`,
    )
    .all(tenantId) as GroupMemberRow[];
}

/** Explicit groups of a principal (without the computed all-agents group). */
export function listGroupIdsOf(db: Db, principalId: string): string[] {
  return (db.prepare('SELECT group_id FROM group_members WHERE principal_id = ?').all(principalId) as {
    group_id: string;
  }[]).map((r) => r.group_id);
}
