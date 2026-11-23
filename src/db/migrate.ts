// Migrations: numbered SQL files in migrations/, tracked by PRAGMA user_version, forward only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './open.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** The migrations/ directory is searched upward from this file: works from both src/ and dist/src/. */
export function migrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'migrations');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('migrations directory not found');
}

export function loadMigrations(dir = migrationsDir()): Migration[] {
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f));
  const list = files
    .map((f) => ({ version: Number(f.slice(0, 4)), name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }))
    .sort((a, b) => a.version - b.version);
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration numbering gap at ${m.name}`);
  });
  return list;
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Applies missing migrations; each in its own transaction together with user_version. */
export function migrate(db: Db, migrations = loadMigrations()): number[] {
  const current = schemaVersion(db);
  const latest = migrations.length;
  if (current > latest) throw new Error(`database schema ${current} is newer than code (${latest})`);
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }).immediate();
    applied.push(m.version);
  }
  return applied;
}
