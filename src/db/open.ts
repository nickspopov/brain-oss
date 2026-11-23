// Opens the SQLite file with the required pragmas.
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Maximum prepared statements in the connection cache (least recently used ones are evicted). */
const STATEMENT_CACHE_MAX = 2000;

/**
 * Prepared statement cache keyed by SQL text. Each `prepare` in better-sqlite3 holds a native
 * sqlite3_stmt that the garbage collector frees late (and not always): with a `prepare` on every
 * call, process memory grows with every write. The store/ layer calls `db.prepare(sql)` right inside
 * its functions, and the cache makes that free. A statement that is currently executing
 * (`iterate`) is not reused: a nested call gets a freshly prepared one.
 */
function cacheStatements(db: Db): void {
  const cache = new Map<string, Database.Statement>();
  const prepare = db.prepare.bind(db) as (sql: string) => Database.Statement;
  const cached = (sql: string): Database.Statement => {
    const hit = cache.get(sql);
    if (hit) {
      if (hit.busy) return prepare(sql);
      cache.delete(sql);
      cache.set(sql, hit);
      return hit;
    }
    const stmt = prepare(sql);
    cache.set(sql, stmt);
    if (cache.size > STATEMENT_CACHE_MAX) cache.delete(cache.keys().next().value!);
    return stmt;
  };
  Object.defineProperty(db, 'prepare', { value: cached, writable: false, configurable: false });
}

export function openDb(file: string, opts: { readonly?: boolean } = {}): Db {
  const db = new Database(file, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  cacheStatements(db);
  if (!opts.readonly) db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -32000');
  db.pragma('mmap_size = 0');
  return db;
}
