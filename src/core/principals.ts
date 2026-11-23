// Principals: creating humans and agents, the first superadmin, changes, disabling.
// The superadmin is only a human and only via `brain admin create`; capability `admin`
// is granted explicitly to any kind.
import { deleteSessionsOf } from '../store/sessions.js';
import type { Kind, PrincipalRole, PrincipalRow, Trust } from '../store/types.js';
import {
  countActiveSuperadmins,
  currentSeq,
  getPrincipalByName,
  insertPrincipal,
  listPrincipals,
  updatePrincipal,
  type PrincipalPatch,
} from '../store/principals.js';
import { bumpAcl } from './access/snapshot.js';
import type { Core } from './context.js';
import { conflict, invalidInput } from './errors.js';
import { newId } from './ids.js';
import { isValidName } from './names.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './password.js';

export interface CreatePrincipalInput {
  name: string;
  displayName?: string;
  kind: Exclude<Kind, 'system'>;
  role?: PrincipalRole;
  trust: Trust;
  ownerId?: string | null;
  harness?: string | null;
  password?: string;
  /** Capability `admin`. Off by default; the agent from BRAIN_BOOTSTRAP_ADMIN_AGENT gets it automatically. */
  admin?: boolean;
  /** External principal: an agent of another person, never admin. */
  external?: boolean;
  ownerLabel?: string | null;
  /** JSON of per-principal limits (core/external.ts); null = defaults. */
  limits?: string | null;
}

export function checkPassword(password: string, field = 'password'): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw invalidInput(field, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
}

export function createPrincipal(core: Core, input: CreatePrincipalInput, createdBy: string | null): PrincipalRow {
  if (!isValidName(input.name)) throw invalidInput('name', 'Name must match ^[a-z0-9][a-z0-9-]{1,62}$.');
  const role = input.role ?? 'member';
  if (role === 'superadmin' && input.kind !== 'human') throw invalidInput('kind', 'Only a human can be superadmin.');
  if (input.password !== undefined && input.kind !== 'human') throw invalidInput('password', 'Only a human has a password.');
  if (input.password !== undefined) checkPassword(input.password);
  if (input.external && input.kind !== 'agent') throw invalidInput('external', 'Only an agent can be external.');
  if (input.external && input.admin) throw invalidInput('admin', 'An external agent cannot have the admin capability.');
  const bootstrapAdmin = core.config.bootstrapAdminAgent !== null && core.config.bootstrapAdminAgent === input.name;
  const now = core.now();
  return core.db
    .transaction(() => {
      if (getPrincipalByName(core.db, core.tenantId, input.name)) throw conflict('name_taken');
      const row: PrincipalRow = {
        id: newId(now),
        tenant_id: core.tenantId,
        name: input.name,
        display_name: input.displayName ?? input.name,
        kind: input.kind,
        role,
        trust: input.trust,
        owner_id: input.ownerId ?? null,
        harness: input.harness ?? null,
        password_hash: input.password !== undefined ? hashPassword(input.password) : null,
        start_seq: currentSeq(core.db),
        disabled_at: null,
        can_admin: (input.admin || bootstrapAdmin) && !input.external ? 1 : 0,
        external: input.external ? 1 : 0,
        owner_label: input.ownerLabel ?? null,
        limits: input.limits ?? null,
        created_at: now,
        created_by: createdBy,
      };
      insertPrincipal(core.db, row);
      bumpAcl(core);
      return row;
    })
    .immediate();
}

/** The first (or another) superadmin: a human with a password and trust = admin. */
export function createSuperadmin(core: Core, name: string, password: string, displayName?: string): PrincipalRow {
  return createPrincipal(
    core,
    { name, kind: 'human', role: 'superadmin', trust: 'admin', password, ...(displayName ? { displayName } : {}) },
    null,
  );
}

/** Principal by name; the system principal `system` is never returned. */
export function findPrincipal(core: Core, name: string): PrincipalRow | undefined {
  const p = getPrincipalByName(core.db, core.tenantId, name);
  return p && p.kind !== 'system' ? p : undefined;
}

export function allPrincipals(core: Core): PrincipalRow[] {
  return listPrincipals(core.db, core.tenantId).filter((p) => p.kind !== 'system');
}

export function patchPrincipal(core: Core, id: string, patch: PrincipalPatch): void {
  core.db.transaction(() => {
    updatePrincipal(core.db, id, patch);
    // Changing the password ends all sessions: passwords are changed on suspicion of a leak.
    if (patch.password_hash !== undefined) deleteSessionsOf(core.db, id);
    bumpAcl(core);
  })();
}

/**
 * Disabling: all tokens and sessions stop working from the next request (tokens check
 * disabled_at, sessions are deleted). The last active superadmin cannot be disabled.
 */
export function setDisabled(core: Core, p: PrincipalRow, disabled: boolean): void {
  core.db
    .transaction(() => {
      if (disabled && p.disabled_at === null) {
        if (p.role === 'superadmin' && countActiveSuperadmins(core.db, core.tenantId) <= 1) throw conflict('last_superadmin');
        updatePrincipal(core.db, p.id, { disabled_at: core.now() });
        deleteSessionsOf(core.db, p.id);
        core.waiters.revokePrincipal(p.id);
      } else if (!disabled && p.disabled_at !== null) {
        updatePrincipal(core.db, p.id, { disabled_at: null });
      }
      bumpAcl(core);
    })
    .immediate();
}

/** Without a superadmin the server answers 503 to everything except /healthz. */
export function hasSuperadmin(core: Core): boolean {
  return countActiveSuperadmins(core.db, core.tenantId) > 0;
}
