// Shared by the admin_* operations: visible to all adapters, but only
// to callers with the `admin` capability; to others they are indistinguishable from a non-existent operation.
import { z } from 'zod';
import { grantViews, type GrantView, type GroupView, type PrincipalView, type SpaceView, type TokenView } from '../../core/admin.js';
import type { AccessContext } from '../../core/guard.js';
import type { MemberAccess } from '../../core/members.js';
import type { IsolationSpec } from '../define.js';
import { RequestIdSchema, RoleSchema, TrustSchema, toIso } from '../types.js';

export const ADMIN = {
  effect: 'admin',
  requires: 'admin',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.admin',
} as const;

export const ADMIN_ISOLATION: IsolationSpec = {
  kind: 'not_applicable',
  reason:
    'admin operations are invisible to callers without the admin capability; the registry walk checks ' +
    'that for such callers they are indistinguishable from a missing operation',
};

export const NameSchema = z.string().min(1).max(63);
export const RequestId = { request_id: RequestIdSchema.optional() };
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : toIso(ms));

export const SpaceViewSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  review_mode: z.enum(['off', 'limited', 'all']),
  executable: z.boolean(),
  inbox: z.boolean(),
  ttl_days: z.number().int().nullable(),
  trash_retention_days: z.number().int().nullable(),
  quota_bytes: z.number().int(),
  max_doc_bytes: z.number().int().nullable(),
  protected_paths: z.array(z.string()),
  bytes_used: z.number().int(),
  archived: z.boolean(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
});

export function spaceOut(s: SpaceView): z.input<typeof SpaceViewSchema> {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    review_mode: s.review_mode,
    executable: s.executable,
    inbox: s.inbox,
    ttl_days: s.ttl_days,
    trash_retention_days: s.trash_retention_days,
    quota_bytes: s.quota_bytes,
    max_doc_bytes: s.max_doc_bytes,
    protected_paths: s.protected_paths,
    bytes_used: s.bytes_used,
    archived: s.archived_at !== null,
    archived_at: isoOrNull(s.archived_at),
    created_at: toIso(s.created_at),
  };
}

export const PrincipalViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
  kind: z.enum(['human', 'agent', 'system']),
  role: z.enum(['superadmin', 'member']),
  trust: TrustSchema,
  admin: z.boolean(),
  owner: z.string().nullable(),
  harness: z.string().nullable(),
  disabled: z.boolean(),
  disabled_at: z.string().nullable(),
  created_at: z.string(),
  /** External principal; null for everyone else. */
  external: z
    .object({
      owner_label: z.string().nullable(),
      limits: z.object({
        msgs_per_day: z.number().int().nullable(),
        body_bytes: z.number().int().nullable(),
        pending_per_recipient: z.number().int().nullable(),
        token_days: z.number().int().nullable(),
      }),
      sent_today: z.number().int(),
    })
    .nullable(),
  /** Profile — one line "what I do", how to reach it / response times; last use of Brain. */
  what_i_do: z.string().nullable(),
  contact: z.string().nullable(),
  last_seen: z.string().nullable(),
});

/** Per-principal limits of an external agent: an integer, or null for no limit; omitted = unchanged/default. */
export const LimitsInputSchema = z
  .object({
    msgs_per_day: z.number().int().min(1).nullable().optional(),
    body_bytes: z.number().int().min(1).nullable().optional(),
    pending_per_recipient: z.number().int().min(1).nullable().optional(),
    token_days: z.number().int().min(1).nullable().optional(),
  })
  .strict();

export function principalOut(p: PrincipalView): z.input<typeof PrincipalViewSchema> {
  return {
    id: p.id,
    name: p.name,
    display_name: p.display_name,
    kind: p.kind,
    role: p.role,
    trust: p.trust,
    admin: p.admin,
    owner: p.owner,
    harness: p.harness,
    disabled: p.disabled_at !== null,
    disabled_at: isoOrNull(p.disabled_at),
    created_at: toIso(p.created_at),
    external: p.external,
    what_i_do: p.what_i_do,
    contact: p.contact,
    last_seen: isoOrNull(p.last_seen),
  };
}

export const TokenViewSchema = z.object({
  id: z.string(),
  principal: z.string(),
  prefix: z.string(),
  label: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  revoked: z.boolean(),
  revoked_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  last_used_ip: z.string().nullable(),
});

export function tokenOut(t: TokenView): z.input<typeof TokenViewSchema> {
  return {
    id: t.id,
    principal: t.principal,
    prefix: t.prefix,
    label: t.label,
    created_at: toIso(t.created_at),
    expires_at: isoOrNull(t.expires_at),
    revoked: t.revoked_at !== null,
    revoked_at: isoOrNull(t.revoked_at),
    last_used_at: isoOrNull(t.last_used_at),
    last_used_ip: t.last_used_ip,
  };
}

export const GroupViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  system: z.boolean(),
  members: z.array(z.string()),
});

export function groupOut(g: GroupView): z.input<typeof GroupViewSchema> {
  return { id: g.id, name: g.name, description: g.description, system: g.system, members: g.members };
}

export const SubjectSchema = z.object({ type: z.enum(['principal', 'group']), name: NameSchema }).strict();
export const ScopeSchema = z.enum(['space', 'path', 'doc']);

export const GrantViewSchema = z.object({
  id: z.string(),
  space: z.string(),
  scope: ScopeSchema,
  path_prefix: z.string().nullable(),
  doc_id: z.string().nullable(),
  subject: z.object({ type: z.enum(['principal', 'group']), name: z.string() }),
  role: RoleSchema,
  granted_by: z.string().nullable(),
  granted_at: z.string(),
});

export function grantOut(g: GrantView): z.input<typeof GrantViewSchema> {
  return { ...g, subject: { ...g.subject }, granted_at: toIso(g.granted_at) };
}

export const LadderSchema = z.enum(['none', 'guest', 'viewer', 'proposer', 'editor', 'admin']);

/** The role on the ladder of one principal in one space (a read model over the engine). */
export const MemberAccessSchema = z.object({
  role: LadderSchema,
  engine_role: RoleSchema,
  messages_only: z.boolean(),
  external_as_guest: z.boolean(),
  superadmin: z.boolean(),
  personal: RoleSchema.nullable(),
  groups: z.array(z.object({ name: z.string(), role: RoleSchema })),
  overrides: z.array(GrantViewSchema),
  custom: z.boolean(),
  visible: z.boolean(),
  member: z.boolean(),
});

export function memberAccessOut(ctx: AccessContext, a: MemberAccess): z.input<typeof MemberAccessSchema> {
  return { ...a, groups: a.groups.map((g) => ({ ...g })), overrides: grantViews(ctx, a.overrides).map(grantOut) };
}
