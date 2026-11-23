// Search index: only the head revision of live documents. Updated by step 10 of `commit` in the
// same transaction (read-your-writes). The tokenizer version is stored in `meta`; on mismatch the
// index is rebuilt at startup (and by the `brain reindex` command).
import { listLiveDocs, clearFts, deleteFts, getMeta, setMeta, upsertFts, type FtsColumns } from '../../store/search.js';
import { readTextBlob } from '../blobs.js';
import type { Core } from '../context.js';
import { parseText } from '../frontmatter.js';
import { stemLine, TOKENIZER_VERSION } from './tokenize.js';

const META_KEY = 'search.tokenizer';

export interface IndexDoc {
  num: number;
  path: string;
  kind: 'text' | 'file';
  title: string;
  /** Head body (for text). */
  text?: string | undefined;
}

/** FTS columns for a document: space-separated stems. For files, only title and path. */
export function ftsColumns(doc: IndexDoc): FtsColumns {
  const path = stemLine(doc.path);
  const title = stemLine(doc.title);
  if (doc.kind !== 'text' || doc.text === undefined) return { title, path, tags: '', headings: '', body: '' };
  const p = parseText(doc.text, doc.path);
  return {
    title,
    path,
    tags: stemLine(p.tags.join(' ')),
    headings: stemLine(p.headings.map((h) => h.text).join('\n')),
    body: stemLine(p.body),
  };
}

/** Step 10 of `commit`: the index row for a live document, or its removal. */
export function indexDocument(core: Core, doc: IndexDoc, live: boolean): void {
  if (!live) {
    deleteFts(core.db, doc.num);
    return;
  }
  upsertFts(core.db, doc.num, ftsColumns(doc));
}

/** Full index rebuild from the heads of live documents. */
export function reindexAll(core: Core): number {
  let n = 0;
  core.db
    .transaction(() => {
      clearFts(core.db);
      for (const d of listLiveDocs(core.db)) {
        const text = d.kind === 'text' ? readTextBlob(core, d.content_hash) : undefined;
        upsertFts(core.db, d.num, ftsColumns({ num: d.num, path: d.path, kind: d.kind, title: d.title, text }));
        n++;
      }
      setMeta(core.db, META_KEY, TOKENIZER_VERSION);
    })
    .immediate();
  return n;
}

/** At startup: rebuild the index if the tokenizer version changed (or there was no index yet). */
export function ensureSearchIndex(core: Core): boolean {
  if (getMeta(core.db, META_KEY) === TOKENIZER_VERSION) return false;
  reindexAll(core);
  return true;
}
