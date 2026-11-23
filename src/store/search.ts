// Search index (fts_docs): SQL only, no permissions. Written by core/search/index (from commit),
// read by guard: the permission condition arrives as a ready-made SQL fragment.
import type { Db } from '../db/open.js';

export interface FtsColumns {
  title: string;
  path: string;
  tags: string;
  headings: string;
  body: string;
}

export function deleteFts(db: Db, num: number): void {
  db.prepare('DELETE FROM fts_docs WHERE rowid = ?').run(num);
}

export function upsertFts(db: Db, num: number, cols: FtsColumns): void {
  deleteFts(db, num);
  db.prepare('INSERT INTO fts_docs (rowid, title, path, tags, headings, body) VALUES (?, ?, ?, ?, ?, ?)').run(
    num,
    cols.title,
    cols.path,
    cols.tags,
    cols.headings,
    cols.body,
  );
}

export function clearFts(db: Db): void {
  db.prepare('DELETE FROM fts_docs').run();
}

export interface IndexSource {
  num: number;
  path: string;
  kind: 'text' | 'file';
  title: string;
  meta: string;
  content_hash: string;
}

/** Live documents for an index rebuild (as a list: during a write an iterator would hold the connection). */
export function listLiveDocs(db: Db): IndexSource[] {
  return db
    .prepare('SELECT num, path, kind, title, meta, content_hash FROM documents WHERE deleted_at IS NULL ORDER BY num')
    .all() as IndexSource[];
}

export function getMeta(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** SQL condition on document `d` with parameters (built by guard). */
export interface SqlFilter {
  sql: string;
  params: (string | number)[];
}

export interface SearchQuery {
  match: string;
  filter: SqlFilter;
  /** path_key prefix (substr, no LIKE). */
  pathPrefixKey?: string | undefined;
  cap: number;
}


function candidatesSql(q: SearchQuery, columns: string, selectParams: readonly string[] = []): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [...selectParams, q.match, ...q.filter.params];
  let prefix = '';
  if (q.pathPrefixKey) {
    prefix = 'AND substr(d.path_key, 1, ?) = ?';
    params.push(q.pathPrefixKey.length, q.pathPrefixKey);
  }
  params.push(q.cap);
  return {
    sql: `SELECT ${columns}
       FROM fts_docs JOIN documents d ON d.num = fts_docs.rowid
       WHERE fts_docs MATCH ? AND d.deleted_at IS NULL AND (${q.filter.sql}) ${prefix}
       ORDER BY d.updated_at DESC, d.num DESC
       LIMIT ?`,
    params,
  };
}

export interface SearchKeyRow {
  num: number;
  id: string;
  /** Same as id: the row fits guard.filterDocs directly. */
  doc_id: string;
  space_id: string;
  path_key: string;
  updated_at: number;
  meta: string;
}

/**
 * Search candidates: FTS5 match, live documents, permission condition, all in one SQL up to the
 * cap. The order used for the `cap` cut-off does not depend on index statistics. Stem columns are
 * not read: ranking statistics come from docSizes and termStats.
 */
export function searchRowKeys(db: Db, q: SearchQuery): SearchKeyRow[] {
  const { sql, params } = candidatesSql(q, 'd.num, d.id, d.id AS doc_id, d.space_id, d.path_key, d.updated_at, d.meta');
  return db.prepare(sql).all(...params) as SearchKeyRow[];
}

// --- Ranking statistics from the FTS5 index (without reading columns) ------------------------------

const vocabReady = new WeakSet<Db>();

/** fts5vocab (instance) over fts_docs in the connection's temp schema: term occurrences with positions. */
function vocab(db: Db): void {
  if (vocabReady.has(db)) return;
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_vocab USING fts5vocab(main, fts_docs, instance)');
  vocabReady.add(db);
}

/** Index term: exact, or a prefix range [from, to). */
export type TermKey = { exact: string } | { from: string; to: string };

function termWhere(t: TermKey): { sql: string; params: string[] } {
  return 'exact' in t ? { sql: 'term = ?', params: [t.exact] } : { sql: 'term >= ? AND term < ?', params: [t.from, t.to] };
}

/** Term occurrence count per (document, column) across the whole index; the caller picks its candidates. */
export function termCounts(db: Db, t: TermKey): { doc: number; col: string; n: number }[] {
  vocab(db);
  const w = termWhere(t);
  return db.prepare(`SELECT doc, col, count(*) AS n FROM temp.fts_vocab WHERE ${w.sql} GROUP BY doc, col`).all(...w.params) as {
    doc: number;
    col: string;
    n: number;
  }[];
}

/** Positions of term occurrences (for phrases). */
export function termInstances(db: Db, t: TermKey): { doc: number; col: string; offset: number }[] {
  vocab(db);
  const w = termWhere(t);
  return db.prepare(`SELECT doc, col, "offset" AS offset FROM temp.fts_vocab WHERE ${w.sql}`).all(...w.params) as {
    doc: number;
    col: string;
    offset: number;
  }[];
}

/** Column lengths of a document in tokens from fts_docs_docsize (one varint per column, in table column order). */
export function docSize(db: Db, num: number): number[] | undefined {
  const r = db.prepare('SELECT sz FROM fts_docs_docsize WHERE id = ?').get(num) as { sz: Buffer } | undefined;
  if (!r) return undefined;
  const out: number[] = [];
  let i = 0;
  while (i < r.sz.length) {
    let v = 0;
    let b: number;
    let k = 0;
    do {
      b = r.sz[i++]!;
      v = k === 8 ? v * 256 + b : v * 128 + (b & 0x7f);
      k++;
    } while (b & 0x80 && k < 9 && i < r.sz.length);
    out.push(v);
  }
  return out;
}

/** Number of live documents under the condition (and the match, if given): bm25 statistics. */
export function countRows(db: Db, filter: SqlFilter, match?: string): number {
  if (match === undefined) {
    return (db.prepare(`SELECT count(*) AS n FROM documents d WHERE d.deleted_at IS NULL AND (${filter.sql})`).get(...filter.params) as { n: number }).n;
  }
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM fts_docs JOIN documents d ON d.num = fts_docs.rowid
         WHERE fts_docs MATCH ? AND d.deleted_at IS NULL AND (${filter.sql})`,
      )
      .get(match, ...filter.params) as { n: number }
  ).n;
}

/** For doctor: live documents without an index row, and index rows without a live document. */
export function indexMismatches(db: Db): { missing: number; stale: number } {
  const missing = (
    db
      .prepare('SELECT count(*) AS n FROM documents d WHERE d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM fts_docs WHERE fts_docs.rowid = d.num)')
      .get() as { n: number }
  ).n;
  const stale = (
    db
      .prepare(
        'SELECT count(*) AS n FROM fts_docs WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.num = fts_docs.rowid AND d.deleted_at IS NULL)',
      )
      .get() as { n: number }
  ).n;
  return { missing, stale };
}

/** Merges FTS5 segments: deleted rows leave the shadow tables (purge). */
export function optimizeFts(db: Db): void {
  db.prepare("INSERT INTO fts_docs(fts_docs) VALUES ('optimize')").run();
}
