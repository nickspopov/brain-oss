// Migration 0001 creates the whole schema from scratch; doctor is clean on an empty DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/core/bootstrap.js';
import { runDoctor } from '../../src/core/doctor.js';
import { loadMigrations, migrate, schemaVersion } from '../../src/db/migrate.js';
import { openDb, type Db } from '../../src/db/open.js';

const TABLES = [
  'meta', 'tenants', 'principals', 'tokens', 'sessions', 'groups', 'group_members', 'spaces', 'grants',
  'documents', 'revisions', 'blobs', 'doc_ystate', 'yclients', 'fts_docs', 'proposals', 'cursors',
  'doc_seen', 'idempotency', 'audit', 'webhooks', 'webhook_outbox', 'exports',
];

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-schema-'));
  db = openDb(path.join(dir, 'brain.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(): { tenantId: string; systemId: string } {
  migrate(db);
  const { tenantId } = bootstrap(db, 'alice', Date.now());
  const sys = db.prepare("SELECT id FROM principals WHERE name = 'system'").get() as { id: string };
  return { tenantId, systemId: sys.id };
}

describe('schema', () => {
  it('creates every table from scratch', () => {
    expect(migrate(db)).toEqual(loadMigrations().map((m) => m.version));
    expect(schemaVersion(db)).toBe(loadMigrations().length);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]).map((r) => r.name);
    for (const t of TABLES) expect(names, t).toContain(t);
  });

  it('is applied once: re-running migrate is a no-op', () => {
    migrate(db);
    expect(migrate(db)).toEqual([]);
  });

  it('pragmas are set', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('bootstrap creates the tenant, the system principal and all-agents, idempotently', () => {
    const { tenantId } = setup();
    bootstrap(db, 'alice', Date.now());
    expect(db.prepare('SELECT count(*) n FROM tenants').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT kind, role FROM principals WHERE name = 'system' AND tenant_id = ?").get(tenantId)).toEqual({ kind: 'system', role: 'member' });
    expect(db.prepare("SELECT system FROM groups WHERE name = 'all-agents'").get()).toEqual({ system: 1 });
  });

  it('brain doctor is clean on an empty database', () => {
    setup();
    expect(runDoctor(db, { expectedSchemaVersion: loadMigrations().length })).toEqual({ ok: true, problems: [] });
  });

  it('the system principal cannot be superadmin or hold the admin capability (CHECK)', () => {
    // The CHECK "superadmin ⇒ human" is gone, the admin capability can be granted to any kind;
    // no core function creates a superadmin agent (checked in core/principals).
    const { tenantId } = setup();
    const ins = (kind: string, role: string, canAdmin: number) =>
      db
        .prepare(
          `INSERT INTO principals (id, tenant_id, name, display_name, kind, role, trust, can_admin, created_at)
           VALUES (?, ?, ?, 'x', ?, ?, 'admin', ?, 0)`,
        )
        .run(`id-${kind}-${role}-${canAdmin}`, tenantId, `p-${kind}-${role}-${canAdmin}`, kind, role, canAdmin);
    expect(() => ins('system', 'superadmin', 0)).toThrow(/CHECK/);
    expect(() => ins('system', 'member', 1)).toThrow(/CHECK/);
    expect(() => ins('agent', 'member', 2)).toThrow(/CHECK/);
    ins('agent', 'member', 1);
  });

  it('grants are unique per scope kind (three partial indexes) and scope/field combinations are checked', () => {
    const { tenantId, systemId } = setup();
    db.prepare(`INSERT INTO spaces (id, tenant_id, slug, name, created_at) VALUES ('s1', ?, 'shared', 'Shared', 0)`).run(tenantId);
    const ins = db.prepare(
      `INSERT INTO grants (id, space_id, scope, path_prefix, doc_id, subject_type, subject_id, role, granted_at)
       VALUES (?, 's1', ?, ?, ?, 'principal', ?, 'read', 0)`,
    );
    ins.run('g1', 'space', null, null, systemId);
    expect(() => ins.run('g2', 'space', null, null, systemId)).toThrow(/UNIQUE/);
    ins.run('g3', 'path', 'a/', null, systemId);
    expect(() => ins.run('g4', 'path', 'a/', null, systemId)).toThrow(/UNIQUE/);
    ins.run('g5', 'path', 'a/b/', null, systemId);
    expect(() => ins.run('g6', 'path', 'a', null, systemId)).toThrow(/CHECK/);
    expect(() => ins.run('g7', 'space', 'a/', null, systemId)).toThrow(/CHECK/);
    expect(() => ins.run('g8', 'doc', null, null, systemId)).toThrow(/CHECK/);
  });

  it('revisions are immutable except purged_*', () => {
    const { tenantId, systemId } = setup();
    db.prepare(
      `INSERT INTO spaces (id, tenant_id, slug, name, created_at) VALUES ('s1', ?, 'shared', 'Shared', 0)`,
    ).run(tenantId);
    db.prepare(`INSERT INTO blobs (hash, storage, text, size, created_at) VALUES ('h', 'inline', '', 0, 0)`).run();
    db.prepare(
      `INSERT INTO documents (id, tenant_id, space_id, path, path_key, kind, mime, title, head_rev, head_seq,
         content_hash, size, trust_floor, created_at, created_by, updated_at, updated_by)
       VALUES ('d1', ?, 's1', 'a.md', 'a.md', 'text', 'text/markdown', 'a', 1, 1, 'h', 0, 'admin', 0, ?, 0, ?)`,
    ).run(tenantId, systemId, systemId);
    db.prepare(
      `INSERT INTO revisions (doc_id, rev, kind, space_id, path, content_hash, size, author_id, author_trust, via, created_at)
       VALUES ('d1', 1, 'create', 's1', 'a.md', 'h', 0, ?, 'admin', 'system', 0)`,
    ).run(systemId);
    expect(() => db.prepare("UPDATE revisions SET message = 'changed' WHERE doc_id = 'd1'").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE revisions SET content_hash = 'x' WHERE doc_id = 'd1'").run()).toThrow(/immutable/);
    db.prepare("UPDATE revisions SET purged_at = 1, purged_by = ? WHERE doc_id = 'd1'").run(systemId);
    expect(db.prepare("SELECT purged_at FROM revisions WHERE doc_id = 'd1'").get()).toEqual({ purged_at: 1 });
    // doctor notices tampered data: the body does not match the hash, the Yjs body is missing.
    expect(runDoctor(db, { expectedSchemaVersion: 1 }).ok).toBe(false);
  });

  it('live paths are unique per space case-insensitively; deleted documents free the path', () => {
    const { tenantId, systemId } = setup();
    db.prepare(`INSERT INTO spaces (id, tenant_id, slug, name, created_at) VALUES ('s1', ?, 'shared', 'Shared', 0)`).run(tenantId);
    const ins = db.prepare(
      `INSERT INTO documents (id, tenant_id, space_id, path, path_key, kind, mime, title, head_rev, head_seq,
         content_hash, size, trust_floor, created_at, created_by, updated_at, updated_by, deleted_at)
       VALUES (?, ?, 's1', ?, lower(?), 'text', 'text/markdown', 't', 1, 1, 'h', 0, 'admin', 0, ?, 0, ?, ?)`,
    );
    ins.run('d1', tenantId, 'A.md', 'A.md', systemId, systemId, 5);
    ins.run('d2', tenantId, 'a.md', 'a.md', systemId, systemId, null);
    expect(() => ins.run('d3', tenantId, 'A.MD', 'A.MD', systemId, systemId, null)).toThrow(/UNIQUE/);
  });

  it('migration 0009 keeps every grant and index, allows guest only as a personal space membership', () => {
    const all = loadMigrations();
    migrate(db, all.slice(0, 8));
    const { tenantId } = bootstrap(db, 'alice', Date.now());
    const sys = db.prepare("SELECT id FROM principals WHERE name = 'system'").get() as { id: string };
    db.prepare("INSERT INTO spaces (id, tenant_id, slug, name, created_at, inbox) VALUES ('s1', ?, 'handoff', 'H', 1, 1)").run(tenantId);
    db.prepare("INSERT INTO grants (id, space_id, scope, path_prefix, subject_type, subject_id, role, granted_at) VALUES ('g1', 's1', 'path', 'a/', 'principal', ?, 'write', 1)").run(sys.id);
    db.prepare("INSERT INTO grants (id, space_id, scope, subject_type, subject_id, role, granted_at) VALUES ('g2', 's1', 'space', 'principal', ?, 'read', 2)").run(sys.id);
    const before = db.prepare('SELECT * FROM grants ORDER BY id').all();
    expect(() => db.prepare("UPDATE grants SET role = 'guest' WHERE id = 'g2'").run()).toThrow(/CHECK/);
    expect(migrate(db, all)).toEqual(all.slice(8).map((m) => m.version));
    expect(db.prepare('SELECT * FROM grants ORDER BY id').all()).toEqual(before);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'grants' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(['grants_doc', 'grants_space', 'grants_subject', 'grants_unique_doc', 'grants_unique_path', 'grants_unique_space']);
    db.prepare("UPDATE grants SET role = 'guest' WHERE id = 'g2'").run();
    expect(() => db.prepare("UPDATE grants SET role = 'guest' WHERE id = 'g1'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE grants SET subject_type = 'group' WHERE id = 'g2'").run()).toThrow(/CHECK/);
    expect(runDoctor(db, { expectedSchemaVersion: all.length }).ok).toBe(true);
  });
});
