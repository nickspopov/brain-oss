import type { Db } from '../db/open.js';
import type { TenantRow } from './types.js';

export function getTenantBySlug(db: Db, slug: string): TenantRow | undefined {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug) as TenantRow | undefined;
}

export function insertTenant(db: Db, row: TenantRow): void {
  db.prepare('INSERT INTO tenants (id, slug, name, created_at) VALUES (@id, @slug, @name, @created_at)').run(row);
}

export function getTenantById(db: Db, id: string): TenantRow | undefined {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as TenantRow | undefined;
}

export function getTenantGuide(db: Db, id: string): string | null {
  const row = db.prepare('SELECT guide_text FROM tenants WHERE id = ?').get(id) as { guide_text: string | null } | undefined;
  return row?.guide_text ?? null;
}

export function setTenantGuide(db: Db, id: string, text: string | null): void {
  db.prepare('UPDATE tenants SET guide_text = ? WHERE id = ?').run(text, id);
}
