// Document and revision views in contract form (DocInfo, RevInfo).
// Rows come from guard already checked; this is only a conversion.
import type { DocumentView } from '../store/documents.js';
import type { RevisionView } from '../store/revisions.js';
import type { Kind, Trust } from '../store/types.js';
import type { AccessContext } from './guard.js';

export interface AuthorOut {
  name: string;
  kind: Kind;
  trust: Trust;
}

export interface DocInfoOut {
  id: string;
  space: string;
  path: string;
  kind: 'text' | 'file';
  mime: string;
  title: string;
  rev: number;
  content_hash: string;
  size: number;
  updated_at: string;
  author: AuthorOut;
  approved_by?: AuthorOut;
  trust_floor: Trust;
  deleted: boolean;
  expires_at?: string;
  tags?: string[];
}

export interface RevInfoOut {
  rev: number;
  kind: RevisionView['kind'];
  author: AuthorOut;
  approved_by?: AuthorOut;
  via: RevisionView['via'];
  message: string;
  created_at: string;
  size: number;
  content_hash: string;
  path?: string;
  prev_path?: string;
  ref_rev?: number;
  purged: boolean;
  attention: boolean;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

function tagsOf(meta: string): string[] | undefined {
  try {
    const m = JSON.parse(meta) as { tags?: unknown };
    const t = m.tags;
    if (typeof t === 'string') return t.trim() ? [t.trim()] : undefined;
    if (Array.isArray(t)) {
      const out = t.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
      return out.length ? out : undefined;
    }
  } catch {
    // meta is always valid JSON (CHECK), but the tag need not be.
  }
  return undefined;
}

export function docInfo(ctx: AccessContext, d: DocumentView): DocInfoOut {
  const tags = tagsOf(d.meta);
  return {
    id: d.id,
    space: ctx.snapshot.spaceById.get(d.space_id)?.slug ?? '',
    path: d.path,
    kind: d.kind,
    mime: d.mime,
    title: d.title,
    rev: d.head_rev,
    content_hash: d.content_hash,
    size: d.size,
    updated_at: iso(d.updated_at),
    author: { name: d.author_name, kind: d.author_kind, trust: d.author_trust },
    ...(d.approver_name !== null
      ? { approved_by: { name: d.approver_name, kind: d.approver_kind!, trust: d.approver_trust! } }
      : {}),
    trust_floor: d.trust_floor,
    deleted: d.deleted_at !== null,
    ...(d.expires_at !== null ? { expires_at: iso(d.expires_at) } : {}),
    ...(tags ? { tags } : {}),
  };
}

export function revInfo(r: RevisionView): RevInfoOut {
  return {
    rev: r.rev,
    kind: r.kind,
    author: { name: r.author_name, kind: r.author_kind, trust: r.author_trust },
    ...(r.approver_name !== null
      ? { approved_by: { name: r.approver_name, kind: r.approver_kind!, trust: r.approver_trust! } }
      : {}),
    via: r.via,
    message: r.message,
    created_at: iso(r.created_at),
    size: r.size,
    content_hash: r.content_hash,
    ...(r.path ? { path: r.path } : {}),
    ...(r.prev_path ? { prev_path: r.prev_path } : {}),
    ...(r.ref_rev !== null ? { ref_rev: r.ref_rev } : {}),
    purged: r.purged_at !== null,
    attention: r.attention === 1,
  };
}
