// Administration helpers: parsing form fields, settings diffs, the grants
// matrix, token status, the connection instructions text.
import type { QueryClient } from '@tanstack/react-query';
import type { AccessLevel, AdminGrant, AdminSpace, AdminToken, Role, SpaceSettingsInput, Subject } from '../api/types';
import { tx } from '../i18n';

export const MB = 1024 * 1024;
export const ROLES: Role[] = ['none', 'guest', 'read', 'propose', 'write', 'admin'];

/** Role labels in grants: here `none` is an explicit deny at that level, not "no access to the root". */
export const GRANT_ROLE_LABEL: Record<Role, string> = {
  ...tx.grants.roleLabel,
};

export const LEVEL_LABEL: Record<AccessLevel, string> = {
  ...tx.grants.level_,
};

/** Suggestions for the "Harness" field: those the server has instructions for (`admin_connect_guide`). */
export { CONNECT_HARNESSES as HARNESSES } from '../api/types';

/** Instructions with a freshly issued token: the server doesn't include the token, the line is added here, once. */
export function withToken(guide: string, token: string): string {
  return tx.adminUi.tokenGuide(token, guide);
}

/** Cache reset after any admin operation: admin lists and what the human themselves sees. */
export async function invalidateAdmin(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['admin'] }),
    qc.invalidateQueries({ queryKey: ['spaces'] }),
    qc.invalidateQueries({ queryKey: ['whoami'] }),
  ]);
}

export function subjectKey(s: Subject): string {
  return `${s.type}:${s.name}`;
}

/** An integer from a form field; empty → `null`; not an integer or less than `min` → `undefined` (input error). */
export function parseIntField(text: string, min = 1): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
}

/** Megabytes from a form field → bytes (fractions allowed: "0.5"). */
export function parseMb(text: string): number | null | undefined {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const bytes = Math.round(Number(t) * MB);
  return bytes >= 1 ? bytes : undefined;
}

export function mbText(bytes: number | null): string {
  if (bytes === null) return '';
  const mb = bytes / MB;
  return Number.isInteger(mb) ? String(mb) : String(Number(mb.toFixed(3)));
}

/** Protected paths: one per line (commas also separate), empty ones are dropped, and so are duplicates. */
export function parsePaths(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const p = raw.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The space settings form: the input fields' strings. */
export interface SpaceForm {
  name: string;
  description: string;
  review_mode: AdminSpace['review_mode'];
  executable: boolean;
  inbox: boolean;
  ttl_days: string;
  trash_retention_days: string;
  quota_mb: string;
  max_doc_mb: string;
  protected_paths: string;
}

export function spaceForm(s?: AdminSpace): SpaceForm {
  return {
    name: s?.name ?? '',
    description: s?.description ?? '',
    review_mode: s?.review_mode ?? 'off',
    executable: s?.executable ?? false,
    inbox: s?.inbox ?? false,
    ttl_days: s?.ttl_days != null ? String(s.ttl_days) : '',
    trash_retention_days: s?.trash_retention_days != null ? String(s.trash_retention_days) : '',
    quota_mb: s ? mbText(s.quota_bytes) : '',
    max_doc_mb: s ? mbText(s.max_doc_bytes) : '',
    protected_paths: (s?.protected_paths ?? []).join('\n'),
  };
}

export type FormResult = { ok: true; settings: SpaceSettingsInput } | { ok: false; field: keyof SpaceForm; message: string };

/**
 * Settings from the form. For an edit (`base`), only the changed fields, so as not to overwrite what
 * the human didn't touch. For creation, empty fields are not sent (the server fills in defaults:
 * review off, no protected paths, a 500 MB quota).
 */
export function settingsFromForm(f: SpaceForm, base?: AdminSpace): FormResult {
  const ttl = parseIntField(f.ttl_days);
  if (ttl === undefined) return { ok: false, field: 'ttl_days', message: tx.adminUi.errors.ttl };
  const trash = parseIntField(f.trash_retention_days);
  if (trash === undefined) return { ok: false, field: 'trash_retention_days', message: tx.adminUi.errors.trash };
  const quota = parseMb(f.quota_mb);
  if (quota === undefined || (quota === null && base)) return { ok: false, field: 'quota_mb', message: tx.adminUi.errors.quota };
  const maxDoc = parseMb(f.max_doc_mb);
  if (maxDoc === undefined) return { ok: false, field: 'max_doc_mb', message: tx.adminUi.errors.maxDoc };
  if (base && f.name.trim() === '') return { ok: false, field: 'name', message: tx.adminUi.errors.name };
  const paths = parsePaths(f.protected_paths);

  const next: SpaceSettingsInput = {
    name: f.name.trim(),
    description: f.description,
    review_mode: f.review_mode,
    executable: f.executable,
    inbox: f.inbox,
    ttl_days: ttl,
    trash_retention_days: trash,
    max_doc_bytes: maxDoc,
    protected_paths: paths,
    ...(quota !== null ? { quota_bytes: quota } : {}),
  };
  if (!base) {
    const s: SpaceSettingsInput = { ...next };
    if (!s.name) delete s.name;
    // Unchecked: the server default (a space named handoff is an inbox).
    if (!s.inbox) delete s.inbox;
    for (const k of ['ttl_days', 'trash_retention_days', 'max_doc_bytes'] as const) if (s[k] === null) delete s[k];
    return { ok: true, settings: s };
  }
  const changed: SpaceSettingsInput = {};
  const was: SpaceSettingsInput = {
    name: base.name,
    description: base.description,
    review_mode: base.review_mode,
    executable: base.executable,
    inbox: base.inbox,
    ttl_days: base.ttl_days,
    trash_retention_days: base.trash_retention_days,
    max_doc_bytes: base.max_doc_bytes,
    protected_paths: base.protected_paths,
    quota_bytes: base.quota_bytes,
  };
  for (const k of Object.keys(next) as (keyof SpaceSettingsInput)[]) {
    if (JSON.stringify(next[k]) !== JSON.stringify(was[k])) (changed as Record<string, unknown>)[k] = next[k];
  }
  return { ok: true, settings: changed };
}

/** The "space × subject" matrix: space-level grants; narrow ones (folder, document) are overrides. */
export function grantMatrix(grants: AdminGrant[]): { cell: (space: string, s: Subject) => AdminGrant | undefined; overrides: AdminGrant[] } {
  const cells = new Map<string, AdminGrant>();
  const overrides: AdminGrant[] = [];
  for (const g of grants) {
    if (g.scope === 'space') cells.set(`${g.space}|${subjectKey(g.subject)}`, g);
    else overrides.push(g);
  }
  overrides.sort((a, b) => a.space.localeCompare(b.space) || targetText(a).localeCompare(targetText(b)) || subjectKey(a.subject).localeCompare(subjectKey(b.subject)));
  return { cell: (space, s) => cells.get(`${space}|${subjectKey(s)}`), overrides };
}

/** A grant's target in words: "the whole space", "folder drafts/", "document 01…". */
export function targetText(g: Pick<AdminGrant, 'scope' | 'path_prefix' | 'doc_id'>): string {
  if (g.scope === 'space') return tx.grants.targetSpace;
  if (g.scope === 'path') return tx.grants.targetFolder(g.path_prefix ?? '');
  return tx.grants.targetDoc(g.doc_id ?? '');
}

/** Folder for a `scope = path` grant: the normalised path with a trailing `/`. */
export function folderPrefix(text: string): string | null {
  const p = text.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p || p.split('/').some((s) => s === '' || s === '.' || s === '..') || p.includes('\\')) return null;
  return `${p}/`;
}

export function tokenStatus(t: AdminToken, now: number = Date.now()): 'revoked' | 'expired' | 'active' {
  if (t.revoked) return 'revoked';
  if (t.expires_at !== null && new Date(t.expires_at).getTime() <= now) return 'expired';
  return 'active';
}
