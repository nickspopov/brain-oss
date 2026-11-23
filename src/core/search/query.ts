// Search. Candidates are selected by a single SQL query that already carries the permission
// condition, up to a cap. Ranking (BM25F with column weights) is computed in the application over
// the accessible set only: N, df and average lengths come from visible documents, so hidden documents
// change neither the results nor their order. `score` is never exposed.
import { readTextBlob } from '../blobs.js';
import { openCursor, sealCursor } from '../cursor.js';
import { docInfo, type DocInfoOut } from '../docview.js';
import { bodyWithoutFrontmatter } from '../frontmatter.js';
import {
  candidateSizes,
  candidateTermCounts,
  candidateTermInstances,
  countReadableDocs,
  readableDocViews,
  searchCandidateKeys,
  visibleSpaceIdsBySlug,
  type AccessContext,
  type TermKey,
} from '../guard.js';
import { matchExpr, matchingTokens, parseQuery, type QueryTerm } from './tokenize.js';

export const COLUMNS = ['title', 'tags', 'path', 'headings', 'body'] as const;
export type Column = (typeof COLUMNS)[number];
const WEIGHTS: Record<Column, number> = { title: 8, tags: 5, path: 4, headings: 3, body: 1 };

/** Maximum candidates per query (after the permission condition). */
const CANDIDATE_CAP = 2000;
/** Result depth: at most 200 results. */
export const MAX_DEPTH = 200;
const K1 = 1.2;
const B = 0.75;
/** Snippet window, in characters. */
const SNIPPET_CHARS = 240;

export interface SearchInput {
  query: string;
  spaces?: string[] | undefined;
  pathPrefix?: string | undefined;
  tags?: string[] | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface Snippet {
  text: string;
  highlights: [number, number][];
}

export interface SearchHit {
  doc: DocInfoOut;
  snippet: Snippet;
  matched_in: Column[];
}

/** Candidate: keys and statistics (stem columns are not read, to save memory). */
interface Candidate {
  num: number;
  id: string;
  updated_at: number;
  /** Column length in tokens. */
  lens: Record<Column, number>;
  /** counts[term][column]: number of occurrences. */
  counts: number[][];
}

interface Scored {
  row: Candidate;
  score: number;
  matched: Column[];
}

/** Column order in the fts_docs table (fts_docs_docsize stores lengths in this order). */
const TABLE_COLUMNS: readonly Column[] = ['title', 'path', 'tags', 'headings', 'body'];

/**
 * Index term for a stem: unicode61 (remove_diacritics) strips diacritics from Latin, so the FTS5
 * vocabulary stores "café" as "cafe". Cyrillic is unchanged (stems already have yo folded into ye).
 */
export function indexTerm(stem: string): string {
  return [...stem].map((ch) => (/\p{Script=Latin}/u.test(ch) ? ch.normalize('NFD').replace(/\p{M}/gu, '') : ch)).join('');
}

function termKey(stem: string, prefix: boolean): TermKey {
  const t = indexTerm(stem);
  return prefix ? { from: t, to: `${t}\u{10FFFF}` } : { exact: t };
}

/**
 * Term occurrences per candidate and column from the FTS5 vocabulary (fts5vocab): a word or prefix is
 * counted from the index; a phrase by positions (each next word at the next position of the same column).
 */
function termCountsByDoc(ctx: AccessContext, term: QueryTerm, nums: ReadonlySet<number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const add = (doc: number, col: string, n: number): void => {
    const ci = COLUMNS.indexOf(col as Column);
    if (ci === -1) return;
    let row = out.get(doc);
    if (!row) out.set(doc, (row = COLUMNS.map(() => 0)));
    row[ci]! += n;
  };
  const last = term.stems.length - 1;
  if (last === 0) {
    for (const r of candidateTermCounts(ctx, termKey(term.stems[0]!, term.prefix), nums)) add(r.doc, r.col, r.n);
    return out;
  }
  const positions = term.stems.map((stem, j) => {
    const set = new Set<string>();
    for (const r of candidateTermInstances(ctx, termKey(stem, term.prefix && j === last), nums)) set.add(`${r.doc}:${r.col}:${r.offset}`);
    return set;
  });
  for (const key of positions[0]!) {
    const [doc, col, off] = key.split(':') as [string, string, string];
    let ok = true;
    for (let j = 1; j <= last && ok; j++) ok = positions[j]!.has(`${doc}:${col}:${Number(off) + j}`);
    if (ok) add(Number(doc), col, 1);
  }
  return out;
}

function tagsOfMeta(meta: string): string[] {
  try {
    const t = (JSON.parse(meta) as { tags?: unknown }).tags;
    if (typeof t === 'string') return [t.trim().toLowerCase()];
    if (Array.isArray(t)) return t.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim().toLowerCase());
  } catch {
    // meta is valid JSON (CHECK); tags are optional.
  }
  return [];
}

function prefixKeyOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const k = raw.normalize('NFC').toLowerCase().replace(/^\/+/, '');
  return k === '' ? undefined : k;
}

/** BM25F over the accessible set: idf from visible documents, column lengths from candidates. */
function rank(ctx: AccessContext, terms: QueryTerm[], rows: Candidate[], idfSource: Map<string, number>): Scored[] {
  const avg = {} as Record<Column, number>;
  for (const c of COLUMNS) {
    const total = rows.reduce((n, r) => n + r.lens[c], 0);
    avg[c] = rows.length > 0 && total > 0 ? total / rows.length : 1;
  }
  const n = countReadableDocs(ctx);
  return rows.map((row) => {
    let score = 0;
    const matched = new Set<Column>();
    terms.forEach((t, ti) => {
      const key = matchExpr([t], 'AND');
      const df = idfSource.get(key) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      let tf = 0;
      COLUMNS.forEach((c, ci) => {
        const k = row.counts[ti]![ci]!;
        if (k === 0) return;
        matched.add(c);
        tf += (WEIGHTS[c] * k) / (1 - B + (B * row.lens[c]) / avg[c]);
      });
      if (tf > 0) score += (idf * tf * (K1 + 1)) / (tf + K1);
    });
    return { row, score, matched: COLUMNS.filter((c) => matched.has(c)) };
  });
}

function byScore(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.row.updated_at !== a.row.updated_at) return b.row.updated_at - a.row.updated_at;
  return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
}

/**
 * Snippet from the source text (the index holds stems, which cannot be shown): a window of about 240
 * characters with the most distinct matched stems. Whitespace runs are collapsed; `highlights` are
 * half-open intervals in the `text` string (JS indices).
 */
export function buildSnippet(text: string, terms: readonly QueryTerm[]): Snippet {
  const hit = (stem: string) =>
    terms.some((t) => t.stems.some((s, j) => stem === s || (t.prefix && j === t.stems.length - 1 && stem.startsWith(s))));
  // Only matched tokens: the whole text is not turned into a token array (search memory).
  const hits = matchingTokens(text, hit);
  let from = 0;
  if (hits.length > 0) {
    // Window [h.start - 40, +240) with the most distinct matched stems: two pointers.
    let best = -1;
    let bestCount = -1;
    const inWindow = new Map<string, number>();
    let lo = 0;
    let hi = 0;
    for (const h of hits) {
      const start = Math.max(0, h.start - 40);
      while (lo < hi && hits[lo]!.start < start) {
        const st = hits[lo++]!.stem;
        const n = inWindow.get(st)! - 1;
        if (n === 0) inWindow.delete(st);
        else inWindow.set(st, n);
      }
      if (hi < lo) hi = lo;
      while (hi < hits.length && hits[hi]!.end <= start + SNIPPET_CHARS) {
        if (hits[hi]!.start >= start) inWindow.set(hits[hi]!.stem, (inWindow.get(hits[hi]!.stem) ?? 0) + 1);
        hi++;
      }
      if (inWindow.size > bestCount) {
        bestCount = inWindow.size;
        best = start;
      }
    }
    from = best;
  }
  let to = Math.min(text.length, from + SNIPPET_CHARS);
  // Do not cut a word or a surrogate pair at the boundaries.
  if (from > 0) {
    const ws = text.slice(from, from + 40).search(/\s/);
    if (ws >= 0 && !hits.some((h) => h.start >= from && h.start < from + ws)) from += ws + 1;
    else if (/[\uDC00-\uDFFF]/.test(text[from] ?? '')) from++;
  }
  if (to < text.length) {
    const tail = text.slice(Math.max(from, to - 40), to);
    const ws = tail.search(/\s\S*$/);
    if (ws >= 0) {
      const cut = Math.max(from, to - 40) + ws;
      if (!hits.some((h) => h.start < to && h.end > cut)) to = cut;
    }
    if (/[\uD800-\uDBFF]/.test(text[to - 1] ?? '')) to--;
  }
  // Collapse whitespace while keeping an index map.
  let out = '';
  const map: number[] = [];
  let space = false;
  for (let i = from; i < to; i++) {
    const ch = text[i]!;
    map[i - from] = out.length;
    if (/\s/.test(ch)) {
      if (!space && out.length > 0) out += ' ';
      space = true;
    } else {
      out += ch;
      space = false;
    }
  }
  map[to - from] = out.length;
  const trimmed = out.trimEnd();
  const highlights: [number, number][] = hits
    .filter((h) => h.start >= from && h.end <= to)
    .map((h): [number, number] => [map[h.start - from]!, Math.min(map[h.end - from]!, trimmed.length)])
    .filter(([a, b]) => b > a);
  return { text: trimmed, highlights };
}

function snippetFor(ctx: AccessContext, view: { kind: 'text' | 'file'; content_hash: string; path: string }, terms: QueryTerm[]): Snippet {
  if (view.kind !== 'text') return { text: '', highlights: [] };
  const text = readTextBlob(ctx.core, view.content_hash);
  if (text === undefined) return { text: '', highlights: [] };
  return buildSnippet(bodyWithoutFrontmatter(text), terms);
}

/** `search`. */
export function search(ctx: AccessContext, input: SearchInput): { results: SearchHit[]; next_cursor?: string } {
  const terms = parseQuery(input.query);
  const spaceIds = input.spaces ? visibleSpaceIdsBySlug(ctx, input.spaces) : undefined;
  const pathPrefixKey = prefixKeyOf(input.pathPrefix);
  const tags = input.tags?.map((t) => t.trim().toLowerCase()).filter((t) => t !== '');
  const params = { q: input.query, s: input.spaces ?? null, p: pathPrefixKey ?? null, t: tags ?? null, l: input.limit };
  const offset = input.cursor ? openCursor(ctx, 'search', input.cursor, params) : 0;
  if (terms.length === 0 || (spaceIds !== undefined && spaceIds.length === 0)) return { results: [] };

  const hasTags = (meta: string): boolean => {
    if (!tags || tags.length === 0) return true;
    const own = tagsOfMeta(meta);
    return tags.every((t) => own.includes(t));
  };
  const query = (op: 'AND' | 'OR') => ({ match: matchExpr(terms, op), spaceIds, pathPrefixKey, cap: CANDIDATE_CAP });
  const keys = searchCandidateKeys(ctx, query(terms.length > 1 ? 'OR' : 'AND')).filter((r) => hasTags(r.meta));
  const nums = new Set(keys.map((k) => k.num));
  const sizes = candidateSizes(ctx, keys.map((k) => k.num));
  const perTerm = terms.map((t) => termCountsByDoc(ctx, t, nums));
  const all: Candidate[] = keys.map((k) => {
    const sz = sizes.get(k.num) ?? [];
    const lens = {} as Record<Column, number>;
    TABLE_COLUMNS.forEach((c, i) => (lens[c] = sz[i] ?? 0));
    return { num: k.num, id: k.id, updated_at: k.updated_at, lens, counts: perTerm.map((m) => m.get(k.num) ?? COLUMNS.map(() => 0)) };
  });
  const andIds =
    terms.length > 1
      ? new Set(searchCandidateKeys(ctx, query('AND')).filter((r) => hasTags(r.meta)).map((r) => r.id))
      : new Set(all.map((r) => r.id));
  const df = new Map<string, number>();
  for (const t of terms) {
    const key = matchExpr([t], 'AND');
    df.set(key, countReadableDocs(ctx, key));
  }
  const scored = rank(ctx, terms, all, df);
  const head = scored.filter((s) => andIds.has(s.row.id)).sort(byScore);
  // "All words" first; then, if there are fewer than limit, an "any word" tail without duplicates.
  const ordered = head.length < input.limit ? [...head, ...scored.filter((s) => !andIds.has(s.row.id)).sort(byScore)] : head;
  const depth = ordered.slice(0, MAX_DEPTH);
  const page = depth.slice(offset, offset + input.limit);
  const views = new Map(readableDocViews(ctx, page.map((s) => s.row.id)).map((v) => [v.id, v]));
  const results: SearchHit[] = [];
  for (const s of page) {
    const v = views.get(s.row.id);
    if (!v) continue;
    results.push({ doc: docInfo(ctx, v), snippet: snippetFor(ctx, v, terms), matched_in: s.matched });
  }
  const next = offset + input.limit < depth.length ? sealCursor(ctx, 'search', offset + input.limit, params) : undefined;
  return { results, ...(next ? { next_cursor: next } : {}) };
}
