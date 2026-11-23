import { getTenantById } from '../store/tenants.js';
import type { Core } from './context.js';

export function currentTenant(core: Core): { slug: string; name: string } {
  const t = getTenantById(core.db, core.tenantId);
  if (!t) throw new Error('tenant row missing');
  return { slug: t.slug, name: t.name };
}
