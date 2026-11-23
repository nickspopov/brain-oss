// Search token pipeline: the same one for indexing and for queries.
// 1. NFC, lower case, ё → е. 2. A token is a contiguous run of Unicode letters and digits.
// 3. Tokens of length 1 are dropped (except digits), tokens longer than 64 are truncated. 4. Stemming
// by script: Cyrillic → Snowball russian, Latin → Snowball english, anything else as is.
// 5. Stopwords are not removed.
import snowball from 'snowball-stemmers';

/**
 * Pipeline version. Stored in `meta` (`search.tokenizer`); on mismatch the index is rebuilt at
 * startup. Any change to the rules below must bump the version.
 */
export const TOKENIZER_VERSION = 'snowball-0.6.0/1';

const ru = snowball.newStemmer('russian');
const en = snowball.newStemmer('english');

const WORD_RE = /[\p{L}\p{N}]+/gu;
const CYRILLIC_RE = /^\p{Script=Cyrillic}+$/u;
const LATIN_RE = /^\p{Script=Latin}+$/u;
const DIGITS_RE = /^\p{N}+$/u;
const MAX_TOKEN = 64;

export interface Token {
  stem: string;
  /** Position of the source word in the text (JS string indices). */
  start: number;
  end: number;
}

/** Normalises one word: NFC, lower case, ё → е; only letters and digits remain. */
function normalizeWord(word: string): string {
  const w = word.normalize('NFC').toLowerCase().replaceAll('ё', 'е');
  // toLowerCase may add combining marks (İ → i̇): they are neither letters nor digits.
  return (w.match(WORD_RE) ?? []).join('');
}

function stemOf(word: string): string {
  if (CYRILLIC_RE.test(word)) return ru.stem(word);
  if (LATIN_RE.test(word)) return en.stem(word);
  return word;
}

/**
 * "Source word → stem" cache: Snowball is expensive and the vocabulary of texts is small (otherwise
 * indexing a 20 KB document spends tens of milliseconds stemming the same words). Bounded by entry count.
 */
const STEM_CACHE_MAX = 20_000;
const stemCache = new Map<string, string | null>();
/** Only words made of letters of a single script are cached (Snowball stems them); numbers and mixed words are not. */
const CACHEABLE_RE = /^(?:\p{Script=Cyrillic}+|\p{Script=Latin}+)$/u;

/** Normalised word → stem, or null if the word is dropped. */
export function stemWord(raw: string): string | null {
  const hit = stemCache.get(raw);
  if (hit !== undefined) return hit;
  const s = stemUncached(raw);
  if (raw.length <= MAX_TOKEN && CACHEABLE_RE.test(raw)) {
    if (stemCache.size >= STEM_CACHE_MAX) stemCache.clear();
    stemCache.set(raw, s);
  }
  return s;
}

function stemUncached(raw: string): string | null {
  let w = normalizeWord(raw);
  if (w.length === 0) return null;
  if ([...w].length === 1 && !DIGITS_RE.test(w)) return null;
  if (w.length > MAX_TOKEN) w = [...w].slice(0, MAX_TOKEN).join('');
  const s = stemOf(w);
  return s.length > 0 ? s : w;
}

/** Tokens of a text with positions (for snippets). */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const stem = stemWord(m[0]);
    if (stem !== null) out.push({ stem, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Tokens whose stem passes `keep` (snippets: the rest are not stored). */
export function matchingTokens(text: string, keep: (stem: string) => boolean): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const stem = stemWord(m[0]);
    if (stem !== null && keep(stem)) out.push({ stem, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Stems only. */
export function stems(text: string): string[] {
  return tokenize(text).map((t) => t.stem);
}

/** Space-separated stems: what is written to the FTS5 column. */
export function stemLine(text: string): string {
  return stems(text).join(' ');
}

// --- Query ---------------------------------------------------------------------------------------

export interface QueryTerm {
  /** One stem is a word; several are a phrase (consecutive). */
  stems: string[];
  /** Prefix search (last word of length ≥ 3). */
  prefix: boolean;
}

/** Maximum terms in a query: beyond that the tail is dropped. */
const MAX_TERMS = 16;

/**
 * Parses a query string: quoted fragments and fragments with inner punctuation (`gmail.py`,
 * `harness-open`) are phrases; everything else is separate words. The last word of length ≥ 3 gets
 * prefix search. User text never reaches FTS syntax (see matchExpr).
 */
export function parseQuery(query: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  let lastWordLen = 0;
  let lastIsWord = false;
  const push = (fragment: string): void => {
    const toks = tokenize(fragment);
    if (toks.length === 0) return;
    terms.push({ stems: toks.map((t) => t.stem), prefix: false });
    lastIsWord = toks.length === 1;
    lastWordLen = toks.length === 1 ? [...normalizeWord(fragment.slice(toks[0]!.start, toks[0]!.end))].length : 0;
  };
  const re = /"([^"]*)"?|(\S+)/g;
  for (const m of query.matchAll(re)) {
    if (m[1] !== undefined) {
      push(m[1]);
      // A quoted word is exact: no prefix.
      lastIsWord = false;
    } else push(m[2]!);
  }
  const dedup: QueryTerm[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    const key = t.stems.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(t);
  }
  const out = dedup.slice(0, MAX_TERMS);
  const last = out[out.length - 1];
  if (last && lastIsWord && lastWordLen >= 3 && last === terms[terms.length - 1]) last.prefix = true;
  return out;
}

/** FTS5 expression of quoted stems: stems are only letters and digits, so they contain no quotes. */
export function matchExpr(terms: readonly QueryTerm[], op: 'AND' | 'OR'): string {
  return terms.map((t) => `"${t.stems.join(' ')}"${t.prefix ? '*' : ''}`).join(` ${op} `);
}

/** How many times a term occurs in a column's stem sequence. */
export function countTerm(seq: readonly string[], term: QueryTerm): number {
  const n = term.stems.length;
  let count = 0;
  for (let i = 0; i + n <= seq.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      const s = seq[i + j]!;
      const q = term.stems[j]!;
      const last = j === n - 1;
      if (!(s === q || (last && term.prefix && s.startsWith(q)))) {
        ok = false;
        break;
      }
    }
    if (ok) count++;
  }
  return count;
}
