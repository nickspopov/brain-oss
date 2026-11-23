// Spaces: creation, settings changes, archiving. Space permissions are in guard.
import { getSpaceById, getSpaceBySlug, insertSpace, listSpaces, updateSpace, type SpacePatch } from '../store/spaces.js';
import type { SpaceRow } from '../store/types.js';
import { bumpAcl } from './access/snapshot.js';
import type { Core } from './context.js';
import { conflict, invalidInput, OpError } from './errors.js';
import { HANDOFF_SPACE } from './handoff.js';
import { newId } from './ids.js';
import { isValidName } from './names.js';
import { normalizePath } from './paths.js';

export interface SpaceSettings {
  name?: string;
  description?: string;
  reviewMode?: SpaceRow['review_mode'];
  executable?: boolean;
  inbox?: boolean;
  ttlDays?: number | null;
  trashRetentionDays?: number | null;
  quotaBytes?: number;
  maxDocBytes?: number | null;
  protectedPaths?: string[];
}

export interface CreateSpaceInput extends SpaceSettings {
  slug: string;
}

/** Display name of the default inbox space `handoff`: General. */
export const GENERAL_NAME = 'General';

const DEFAULT_QUOTA = 500 * 1024 * 1024;

function checkSlug(slug: string, field = 'slug'): void {
  if (!isValidName(slug)) throw invalidInput(field, 'Slug must match ^[a-z0-9][a-z0-9-]{1,62}$.');
}

/** protected_paths: normalised document paths; empty by default. */
function protectedPathsJson(paths: string[]): string {
  const norm = paths.map((p, i) => normalizePath(p, `protected_paths.${i}`));
  return JSON.stringify([...new Set(norm)]);
}

export function parseProtectedPaths(space: SpaceRow): string[] {
  const v = JSON.parse(space.protected_paths) as unknown;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function createSpace(core: Core, input: CreateSpaceInput, createdBy: string | null): SpaceRow {
  checkSlug(input.slug);
  const now = core.now();
  const ttl = input.ttlDays ?? null;
  const row: SpaceRow = {
    id: newId(now),
    tenant_id: core.tenantId,
    slug: input.slug,
    // The default `handoff` space is shown as "General" (slug and id unchanged).
    name: input.name ?? (input.slug === HANDOFF_SPACE ? GENERAL_NAME : input.slug),
    description: input.description ?? '',
    review_mode: input.reviewMode ?? 'off',
    executable: input.executable ? 1 : 0,
    // Without the setting a space named `handoff` is an inbox space, as it always was.
    inbox: (input.inbox ?? input.slug === HANDOFF_SPACE) ? 1 : 0,
    ttl_days: ttl,
    // In spaces with a TTL the trash is purged after 30 days by default.
    trash_retention_days: input.trashRetentionDays !== undefined ? input.trashRetentionDays : ttl !== null ? 30 : null,
    quota_bytes: input.quotaBytes ?? DEFAULT_QUOTA,
    max_doc_bytes: input.maxDocBytes ?? null,
    protected_paths: protectedPathsJson(input.protectedPaths ?? []),
    bytes_used: 0,
    archived_at: null,
    archived_by: null,
    created_at: now,
    created_by: createdBy,
    alias_of: null,
  };
  return core.db
    .transaction(() => {
      if (getSpaceBySlug(core.db, core.tenantId, input.slug)) throw conflict('slug_taken');
      insertSpace(core.db, row);
      bumpAcl(core);
      return row;
    })
    .immediate();
}

/** Space by slug, including archived ones: only for administrative paths and the CLI. */
export function findSpace(core: Core, slug: string): SpaceRow | undefined {
  return getSpaceBySlug(core.db, core.tenantId, slug);
}

export function allSpaces(core: Core): SpaceRow[] {
  return listSpaces(core.db, core.tenantId);
}

/** Messages in the space that are not done or declined (live documents only). */
export function pendingMessages(core: Core, spaceId: string): number {
  return (
    core.db
      .prepare(
        `SELECT count(*) AS n FROM handoff_messages m JOIN documents d ON d.id = m.doc_id
         WHERE d.space_id = ? AND d.deleted_at IS NULL AND NOT (m.resolution IS NOT NULL AND m.resolved_rev >= m.content_rev)`,
      )
      .get(spaceId) as { n: number }
  ).n;
}

export function updateSpaceSettings(core: Core, space: SpaceRow, patch: SpaceSettings & { slug?: string }): SpaceRow {
  const p: SpacePatch = {};
  if (patch.slug !== undefined && patch.slug !== space.slug) {
    checkSlug(patch.slug, 'new_slug');
    p.slug = patch.slug;
  }
  if (patch.name !== undefined) p.name = patch.name;
  if (patch.description !== undefined) p.description = patch.description;
  if (patch.reviewMode !== undefined) p.review_mode = patch.reviewMode;
  if (patch.executable !== undefined) p.executable = patch.executable ? 1 : 0;
  if (patch.inbox !== undefined) p.inbox = patch.inbox ? 1 : 0;
  if (patch.ttlDays !== undefined) p.ttl_days = patch.ttlDays;
  if (patch.trashRetentionDays !== undefined) p.trash_retention_days = patch.trashRetentionDays;
  if (patch.quotaBytes !== undefined) p.quota_bytes = patch.quotaBytes;
  if (patch.maxDocBytes !== undefined) p.max_doc_bytes = patch.maxDocBytes;
  if (patch.protectedPaths !== undefined) p.protected_paths = protectedPathsJson(patch.protectedPaths);
  return core.db
    .transaction(() => {
      if (p.slug !== undefined && getSpaceBySlug(core.db, core.tenantId, p.slug)) throw conflict('slug_taken');
      if (p.inbox === 0 && space.inbox === 1) {
        // Turning the inbox off would hide open messages; close them first.
        const open = pendingMessages(core, space.id);
        if (open > 0) {
          throw new OpError('conflict', { reason: 'pending_messages', pending: open }, `${open} open message${open === 1 ? '' : 's'} in this space; close them (done or declined) before turning inbox off.`);
        }
      }
      updateSpace(core.db, space.id, p);
      bumpAcl(core);
      return getSpaceById(core.db, space.id)!;
    })
    .immediate();
}

/** Archiving is the "deletion" of a space: hidden from everyone except the superadmin; reversible. */
export function setArchived(core: Core, space: SpaceRow, archived: boolean, by: string | null): SpaceRow {
  return core.db
    .transaction(() => {
      if (archived && space.archived_at === null) updateSpace(core.db, space.id, { archived_at: core.now(), archived_by: by });
      if (!archived && space.archived_at !== null) updateSpace(core.db, space.id, { archived_at: null, archived_by: null });
      bumpAcl(core);
      return getSpaceById(core.db, space.id)!;
    })
    .immediate();
}
