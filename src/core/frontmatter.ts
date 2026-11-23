// Frontmatter and headings: the single parse of the body. YAML without tags and without
// execution; invalid frontmatter does not block a write (warning `frontmatter_invalid`).
import { parseDocument } from 'yaml';

export interface Heading {
  level: number;
  text: string;
  /** Line number, starting at 1. */
  line: number;
}

export interface ParsedText {
  meta: Record<string, unknown>;
  title: string;
  tags: string[];
  headings: Heading[];
  /** Body without the frontmatter block (for the index). */
  body: string;
  warnings: string[];
}

const FM_RE = /^---\n([\s\S]*?)\n(?:---|\.\.\.)(?:\n|$)/;
const MAX_FM_BYTES = 64 * 1024;

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string; bodyLine: number; invalid: boolean } {
  const m = FM_RE.exec(text);
  if (!m) return { meta: {}, body: text, bodyLine: 1, invalid: false };
  const body = text.slice(m[0].length);
  const bodyLine = (m[0].match(/\n/g)?.length ?? 0) + 1;
  const src = m[1] ?? '';
  if (src.length > MAX_FM_BYTES || /(^|[\s[{,:])!/.test(src)) {
    // YAML tags (`!!js/function`, `!custom`) are not parsed at all.
    return { meta: {}, body, bodyLine, invalid: true };
  }
  try {
    const doc = parseDocument(src, { schema: 'core', uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length > 0 || doc.warnings.length > 0) return { meta: {}, body, bodyLine, invalid: true };
    const value = doc.toJS({ maxAliasCount: 0 }) as unknown;
    if (value === null || value === undefined) return { meta: {}, body, bodyLine, invalid: false };
    if (typeof value !== 'object' || Array.isArray(value)) return { meta: {}, body, bodyLine, invalid: true };
    return { meta: JSON.parse(JSON.stringify(value)) as Record<string, unknown>, body, bodyLine, invalid: false };
  } catch {
    return { meta: {}, body, bodyLine, invalid: true };
  }
}

/** ATX headings (`#`…`######`) outside code blocks. */
/** Body without the frontmatter block, without parsing YAML or headings (search snippets). */
export function bodyWithoutFrontmatter(text: string): string {
  const m = FM_RE.exec(text);
  return m ? text.slice(m[0].length) : text;
}

export function headingsOf(body: string, firstLine = 1): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  body.split('\n').forEach((line, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const mark = f[1]!;
      if (fence === null) fence = mark[0]!.repeat(mark.length);
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = /^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (h && h[2]) out.push({ level: h[1]!.length, text: h[2].trim(), line: firstLine + i });
  });
  return out;
}

function fileName(path: string): string {
  const seg = path.split('/').pop() ?? path;
  return seg.replace(/\.(md|markdown)$/i, '') || seg;
}

function tagsOf(meta: Record<string, unknown>): string[] {
  const t = meta.tags;
  if (typeof t === 'string') return t.trim() ? [t.trim()] : [];
  if (Array.isArray(t)) return t.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(String);
  return [];
}

/** Metadata of a text document: frontmatter, title, tags, section headings. */
export function parseText(text: string, path: string): ParsedText {
  const fm = parseFrontmatter(text);
  const headings = headingsOf(fm.body, fm.bodyLine);
  const fmTitle = typeof fm.meta.title === 'string' && fm.meta.title.trim() ? fm.meta.title.trim() : null;
  const h1 = headings.find((h) => h.level === 1)?.text ?? null;
  return {
    meta: fm.meta,
    title: (fmTitle ?? h1 ?? fileName(path)).slice(0, 500),
    tags: tagsOf(fm.meta),
    headings,
    body: fm.body,
    warnings: fm.invalid ? ['frontmatter_invalid'] : [],
  };
}

/** Metadata of a file: the title is the file name. */
export function fileTitle(path: string): string {
  return path.split('/').pop() ?? path;
}
