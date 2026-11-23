// Groups: flat; membership in the system group all-agents is computed, there are no rows for it.
import {
  deleteGroup as storeDeleteGroup,
  deleteGroupMembersExcept,
  getGroupByName,
  insertGroup,
  insertGroupMember,
  listGroups,
  listMemberships,
  updateGroup,
} from '../store/groups.js';
import type { GroupRow } from '../store/types.js';
import { bumpAcl } from './access/snapshot.js';
import type { Core } from './context.js';
import { conflict, invalidInput } from './errors.js';
import { newId } from './ids.js';
import { isValidName } from './names.js';

function checkName(name: string, field = 'name'): void {
  if (!isValidName(name)) throw invalidInput(field, 'Group name must match ^[a-z0-9][a-z0-9-]{1,62}$.');
}

export function createGroup(core: Core, name: string, description: string, createdBy: string | null): GroupRow {
  checkName(name);
  const now = core.now();
  const row: GroupRow = { id: newId(now), tenant_id: core.tenantId, name, description, system: 0, created_at: now, created_by: createdBy };
  return core.db
    .transaction(() => {
      if (getGroupByName(core.db, core.tenantId, name)) throw conflict('name_taken');
      insertGroup(core.db, row);
      bumpAcl(core);
      return row;
    })
    .immediate();
}

export function findGroup(core: Core, name: string): GroupRow | undefined {
  return getGroupByName(core.db, core.tenantId, name);
}

export function allGroups(core: Core): GroupRow[] {
  return listGroups(core.db, core.tenantId);
}

/** Explicit members of the tenant's groups: group_id → principal_id[]. */
export function membersByGroup(core: Core): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of listMemberships(core.db, core.tenantId)) {
    const list = out.get(m.group_id);
    if (list) list.push(m.principal_id);
    else out.set(m.group_id, [m.principal_id]);
  }
  return out;
}

function requireEditable(g: GroupRow): void {
  if (g.system === 1) throw conflict('system_group');
}

export function addGroupMember(core: Core, groupId: string, principalId: string, addedBy: string | null): void {
  const all = listGroups(core.db, core.tenantId).find((g) => g.id === groupId);
  if (all && all.system === 1) throw conflict('system_group');
  insertGroupMember(core.db, { group_id: groupId, principal_id: principalId, added_by: addedBy, added_at: core.now() });
  bumpAcl(core);
}

/** Whole group membership: extra members removed, missing ones added, in one transaction. */
export function setGroupMembers(core: Core, group: GroupRow, principalIds: readonly string[], by: string | null): void {
  requireEditable(group);
  core.db
    .transaction(() => {
      deleteGroupMembersExcept(core.db, group.id, principalIds);
      const now = core.now();
      for (const id of principalIds) insertGroupMember(core.db, { group_id: group.id, principal_id: id, added_by: by, added_at: now });
      bumpAcl(core);
    })
    .immediate();
}

export function renameGroup(core: Core, group: GroupRow, patch: { name?: string; description?: string }): GroupRow {
  if (patch.name !== undefined && patch.name !== group.name) {
    requireEditable(group);
    checkName(patch.name, 'new_name');
  }
  return core.db
    .transaction(() => {
      if (patch.name !== undefined && patch.name !== group.name && getGroupByName(core.db, core.tenantId, patch.name)) {
        throw conflict('name_taken');
      }
      updateGroup(core.db, group.id, patch);
      bumpAcl(core);
      return { ...group, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) };
    })
    .immediate();
}

/** Deletes a group together with its grants and memberships. */
export function deleteGroup(core: Core, group: GroupRow): void {
  requireEditable(group);
  core.db
    .transaction(() => {
      storeDeleteGroup(core.db, group.id);
      bumpAcl(core);
    })
    .immediate();
}
