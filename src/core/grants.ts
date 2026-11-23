// Grants: atomic upsert by the key of the scope kind, deletion.
import { deleteGrant, findGrant, listGrantsOfTenant, upsertGrant } from '../store/grants.js';
import type { GrantRow, Role } from '../store/types.js';
import { bumpAcl } from './access/snapshot.js';
import type { Core } from './context.js';
import { invalidInput } from './errors.js';
import { newId } from './ids.js';
import { folderPrefixKey } from './paths.js';

export interface GrantTarget {
  spaceId: string;
  scope: GrantRow['scope'];
  pathPrefix?: string | null;
  docId?: string | null;
  subjectType: GrantRow['subject_type'];
  subjectId: string;
}

export interface SetGrantInput extends GrantTarget {
  role: Role;
}

/** Grant key: checks combinations of scope and fields (duplicates the schema CHECK with a clear error). */
function keyOf(t: GrantTarget) {
  let path_prefix: string | null = null;
  let doc_id: string | null = null;
  if (t.scope === 'path') {
    if (!t.pathPrefix) throw invalidInput('path_prefix', 'path_prefix is required for scope "path".');
    if (t.docId) throw invalidInput('doc_id', 'doc_id is only allowed for scope "doc".');
    path_prefix = folderPrefixKey(t.pathPrefix);
  } else if (t.scope === 'doc') {
    if (!t.docId) throw invalidInput('doc_id', 'doc_id is required for scope "doc".');
    if (t.pathPrefix) throw invalidInput('path_prefix', 'path_prefix is only allowed for scope "path".');
    doc_id = t.docId;
  } else {
    if (t.pathPrefix) throw invalidInput('path_prefix', 'path_prefix is only allowed for scope "path".');
    if (t.docId) throw invalidInput('doc_id', 'doc_id is only allowed for scope "doc".');
  }
  return { space_id: t.spaceId, scope: t.scope, path_prefix, doc_id, subject_type: t.subjectType, subject_id: t.subjectId };
}

/** Granting again on the same key changes the role instead of creating a duplicate. */
export function setGrant(core: Core, input: SetGrantInput, grantedBy: string | null): GrantRow {
  const now = core.now();
  const key = keyOf(input);
  return core.db
    .transaction(() => {
      const id = upsertGrant(core.db, { id: newId(now), ...key, role: input.role, granted_by: grantedBy, granted_at: now });
      bumpAcl(core);
      return { id, ...key, role: input.role, granted_by: grantedBy, granted_at: now };
    })
    .immediate();
}

/** Deletes a grant; `false` if there was none. */
export function removeGrant(core: Core, target: GrantTarget): boolean {
  const key = keyOf(target);
  return core.db
    .transaction(() => {
      const row = findGrant(core.db, key);
      if (!row) return false;
      deleteGrant(core.db, row.id);
      bumpAcl(core);
      return true;
    })
    .immediate();
}

export function allGrants(core: Core): GrantRow[] {
  return listGrantsOfTenant(core.db, core.tenantId);
}
