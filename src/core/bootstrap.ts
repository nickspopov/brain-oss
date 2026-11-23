// Rows required after migrations: tenant, system author, all-agents group.
// Done in code, not in an SQL migration: the tenant slug comes from configuration (BRAIN_TENANT).
import type { Db } from '../db/open.js';
import { getGroupByName, insertGroup } from '../store/groups.js';
import { getPrincipalByName, insertPrincipal, setCanAdminByName } from '../store/principals.js';
import { getTenantBySlug, insertTenant } from '../store/tenants.js';
import { newId } from './ids.js';

export const SYSTEM_PRINCIPAL = 'system';
export const ALL_AGENTS_GROUP = 'all-agents';

/**
 * `adminAgent` (BRAIN_BOOTSTRAP_ADMIN_AGENT): if such a principal already exists,
 * it gets capability `admin`; if it appears later, it gets it on creation (core/principals).
 */
export function bootstrap(db: Db, tenantSlug: string, now: number, adminAgent: string | null = null): { tenantId: string } {
  return db
    .transaction(() => {
      let tenant = getTenantBySlug(db, tenantSlug);
      if (!tenant) {
        tenant = { id: newId(now), slug: tenantSlug, name: tenantSlug, created_at: now };
        insertTenant(db, tenant);
      }
      if (!getPrincipalByName(db, tenant.id, SYSTEM_PRINCIPAL)) {
        insertPrincipal(db, {
          id: newId(now),
          tenant_id: tenant.id,
          name: SYSTEM_PRINCIPAL,
          display_name: 'System',
          kind: 'system',
          role: 'member',
          trust: 'admin',
          owner_id: null,
          harness: null,
          password_hash: null,
          start_seq: 0,
          disabled_at: null,
          can_admin: 0,
          external: 0,
          owner_label: null,
          limits: null,
          created_at: now,
          created_by: null,
        });
      }
      if (!getGroupByName(db, tenant.id, ALL_AGENTS_GROUP)) {
        insertGroup(db, {
          id: newId(now),
          tenant_id: tenant.id,
          name: ALL_AGENTS_GROUP,
          description: 'All enabled agents (computed membership)',
          system: 1,
          created_at: now,
          created_by: null,
        });
      }
      if (adminAgent !== null && adminAgent !== SYSTEM_PRINCIPAL) setCanAdminByName(db, tenant.id, adminAgent);
      return { tenantId: tenant.id };
    })
    .immediate();
}
