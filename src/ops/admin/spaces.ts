// admin_space_create | update | archive | unarchive | list.
import { z } from 'zod';
import { adminSpaceArchive, adminSpaceCreate, adminSpaceList, adminSpaceUpdate } from '../../core/admin.js';
import type { SpaceSettings } from '../../core/spaces.js';
import { defineOp } from '../define.js';
import { PathSchema, SlugSchema } from '../types.js';
import { ADMIN, ADMIN_ISOLATION, GrantViewSchema, grantOut, RequestId, SpaceViewSchema, spaceOut } from './common.js';

const Settings = {
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  review_mode: z.enum(['off', 'limited', 'all']).optional(),
  executable: z.boolean().optional(),
  inbox: z.boolean().optional(),
  ttl_days: z.number().int().min(1).max(36500).nullable().optional(),
  trash_retention_days: z.number().int().min(1).max(36500).nullable().optional(),
  quota_bytes: z.number().int().min(1).optional(),
  max_doc_bytes: z.number().int().min(1).nullable().optional(),
  protected_paths: z.array(PathSchema).max(100).optional(),
};

type SettingsInput = {
  name?: string | undefined;
  description?: string | undefined;
  review_mode?: 'off' | 'limited' | 'all' | undefined;
  executable?: boolean | undefined;
  inbox?: boolean | undefined;
  ttl_days?: number | null | undefined;
  trash_retention_days?: number | null | undefined;
  quota_bytes?: number | undefined;
  max_doc_bytes?: number | null | undefined;
  protected_paths?: string[] | undefined;
};

function settings(i: SettingsInput): SpaceSettings {
  const s: SpaceSettings = {};
  if (i.name !== undefined) s.name = i.name;
  if (i.description !== undefined) s.description = i.description;
  if (i.review_mode !== undefined) s.reviewMode = i.review_mode;
  if (i.executable !== undefined) s.executable = i.executable;
  if (i.inbox !== undefined) s.inbox = i.inbox;
  if (i.ttl_days !== undefined) s.ttlDays = i.ttl_days;
  if (i.trash_retention_days !== undefined) s.trashRetentionDays = i.trash_retention_days;
  if (i.quota_bytes !== undefined) s.quotaBytes = i.quota_bytes;
  if (i.max_doc_bytes !== undefined) s.maxDocBytes = i.max_doc_bytes;
  if (i.protected_paths !== undefined) s.protectedPaths = i.protected_paths;
  return s;
}

const Out = z.object({ space: SpaceViewSchema });

export const adminSpaceCreateOp = defineOp({
  name: 'admin_space_create',
  summary: 'Create a space (admin).',
  description:
    'Creates a space with the given slug and settings. review_mode defaults to "off" and protected_paths to [] ' +
    '(nothing is protected until configured). You (the creator) get the admin role on the new space as a normal ' +
    'grant (returned in grant); everyone else needs grants set with admin_grant_set.',
  input: z.object({ slug: SlugSchema, ...Settings, ...RequestId }).strict(),
  output: z.object({ space: SpaceViewSchema, grant: GrantViewSchema }),
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => {
    const r = adminSpaceCreate(ctx, i.slug, settings(i));
    return { space: spaceOut(r.space), grant: grantOut(r.grant) };
  },
  isolation: ADMIN_ISOLATION,
});

export const adminSpaceUpdateOp = defineOp({
  name: 'admin_space_update',
  summary: 'Change space settings or rename its slug (admin).',
  description:
    'Updates the settings of a space found by slug. new_slug renames it (the id stays). ' +
    'Null clears ttl_days, trash_retention_days and max_doc_bytes.',
  input: z.object({ slug: SlugSchema, new_slug: SlugSchema.optional(), ...Settings, ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({
    space: spaceOut(adminSpaceUpdate(ctx, i.slug, { ...settings(i), ...(i.new_slug !== undefined ? { slug: i.new_slug } : {}) })),
  }),
  isolation: ADMIN_ISOLATION,
});

export const adminSpaceArchiveOp = defineOp({
  name: 'admin_space_archive',
  summary: 'Archive a space: hidden from everyone except superadmin (admin).',
  description: 'Archives a space. It disappears for everyone except superadmin; nothing is deleted and unarchive restores it.',
  input: z.object({ slug: SlugSchema, ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ space: spaceOut(adminSpaceArchive(ctx, i.slug, true)) }),
  isolation: ADMIN_ISOLATION,
});

export const adminSpaceUnarchiveOp = defineOp({
  name: 'admin_space_unarchive',
  summary: 'Bring an archived space back (admin).',
  description: 'Unarchives a space: grants that existed before apply again.',
  input: z.object({ slug: SlugSchema, ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ space: spaceOut(adminSpaceArchive(ctx, i.slug, false)) }),
  isolation: ADMIN_ISOLATION,
});

export const adminSpaceListOp = defineOp({
  name: 'admin_space_list',
  summary: 'List all spaces with their settings (admin).',
  description: 'Lists every space of the tenant with settings and usage; include_archived adds archived ones.',
  input: z.object({ include_archived: z.boolean().optional() }).strict(),
  output: z.object({ spaces: z.array(SpaceViewSchema) }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => ({ spaces: adminSpaceList(ctx, i.include_archived ?? false).map(spaceOut) }),
  isolation: ADMIN_ISOLATION,
});
