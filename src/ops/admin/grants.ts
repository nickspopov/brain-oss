// admin_grant_set | remove | list, admin_access_explain.
import { z } from 'zod';
import { adminAccessExplain, adminGrantList, adminGrantRemove, adminGrantSet } from '../../core/admin.js';
import { previewSpacesMigration, renderSpacesMigration, type SpacesMigration } from '../../core/spacesmigrate.js';
import { defineOp } from '../define.js';
import { IdSchema, PathSchema, RoleSchema, SlugSchema } from '../types.js';
import {
  ADMIN,
  ADMIN_ISOLATION,
  GrantViewSchema,
  MemberAccessSchema,
  memberAccessOut,
  NameSchema,
  PrincipalViewSchema,
  RequestId,
  ScopeSchema,
  SubjectSchema,
  grantOut,
  principalOut,
} from './common.js';

const Key = {
  space: SlugSchema,
  scope: ScopeSchema,
  path_prefix: PathSchema.optional(),
  doc_id: IdSchema.optional(),
  subject: SubjectSchema,
};

export const adminGrantSetOp = defineOp({
  name: 'admin_grant_set',
  summary: 'Give or change a role for a principal or group on a space, folder or document (admin).',
  description:
    'Sets the role (none, guest, read, propose, write, admin) of a subject on a target: the whole space (scope "space"), ' +
    'a folder (scope "path" with path_prefix) or one document (scope "doc" with doc_id). Setting the same target ' +
    'again replaces the role. The narrowest level wins and narrows as well as widens: "none" on a folder hides it ' +
    'even with read on the space. Takes effect from the next call. ' +
    'guest (Guest): messaging-only membership of an inbox space — sends to and receives from its members, reads only ' +
    'its own mail, sees no documents; principal and scope "space" only. read = Viewer, write = Editor, admin = Admin. ' +
    'Messages are readable only by their sender, their recipient and admins of that space; no other grant reveals them.',
  input: z.object({ ...Key, role: RoleSchema, ...RequestId }).strict(),
  output: z.object({ grant: GrantViewSchema }),
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => {
    const { role, request_id: _r, ...key } = i;
    return { grant: grantOut(adminGrantSet(ctx, key, role)) };
  },
  isolation: ADMIN_ISOLATION,
});

export const adminGrantRemoveOp = defineOp({
  name: 'admin_grant_remove',
  summary: 'Remove a grant (admin).',
  description: 'Removes the grant of a subject on a target; the role is then decided by wider levels. not_found if there was none.',
  input: z.object({ ...Key, ...RequestId }).strict(),
  output: z.object({ removed: z.literal(true) }),
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => {
    const { request_id: _r, ...key } = i;
    adminGrantRemove(ctx, key);
    return { removed: true as const };
  },
  isolation: ADMIN_ISOLATION,
});

export const adminGrantListOp = defineOp({
  name: 'admin_grant_list',
  summary: 'List grants, optionally by space or subject (admin).',
  description: 'Lists grants with space, scope, target, subject and role.',
  input: z.object({ space: SlugSchema.optional(), subject: SubjectSchema.optional() }).strict(),
  output: z.object({ grants: z.array(GrantViewSchema) }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => ({ grants: adminGrantList(ctx, i).map(grantOut) }),
  isolation: ADMIN_ISOLATION,
});

const LevelSchema = z.enum(['disabled', 'archived', 'superadmin', 'doc', 'path', 'space', 'none', 'mail']);

export const adminAccessExplainOp = defineOp({
  name: 'admin_access_explain',
  summary: 'See access through the eyes of a principal: what it sees and by which grant (admin).',
  description:
    'For a principal, lists every space with whether it is visible, the role on the space and all grants of the ' +
    'principal and its groups there. With space and path (or doc_id) also gives the role on that target and the ' +
    'grant that decided it. Changes nothing.',
  input: z.object({ principal: NameSchema, space: SlugSchema.optional(), path: PathSchema.optional(), doc_id: IdSchema.optional() }).strict(),
  output: z.object({
    principal: PrincipalViewSchema,
    groups: z.array(z.string()),
    spaces: z.array(
      z.object({
        space: z.string(),
        archived: z.boolean(),
        visible: z.boolean(),
        role: RoleSchema,
        target: z
          .object({
            path: z.string().optional(),
            doc_id: z.string().optional(),
            role: RoleSchema,
            level: LevelSchema,
            decided_by: z.array(GrantViewSchema),
          })
          .optional(),
        grants: z.array(GrantViewSchema),
        /** The role on the ladder (Guest · Viewer · Editor · Admin), custom access, overrides. */
        member: MemberAccessSchema,
      }),
    ),
  }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => {
    const r = adminAccessExplain(ctx, i.principal, { space: i.space, path: i.path, doc_id: i.doc_id });
    return {
      principal: principalOut(r.principal),
      groups: r.groups,
      spaces: r.spaces.map(({ target, member, ...s }) => ({
        ...s,
        member: memberAccessOut(ctx, member),
        grants: s.grants.map(grantOut),
        ...(target ? { target: { ...target, decided_by: target.decided_by.map(grantOut) } } : {}),
      })),
    };
  },
  isolation: ADMIN_ISOLATION,
});

// --- admin_spaces_preview -----------------------------------------------------------

const LadderSchema = z.enum(['none', 'guest', 'viewer', 'proposer', 'editor', 'admin']);

export const adminSpacesPreviewOp = defineOp({
  name: 'admin_spaces_preview',
  summary: 'Dry run of moving an inbox space into its project space (Messages of the project), per declared pair (admin).',
  description:
    'Changes nothing. pairs: explicit { project, inbox } slugs (never guessed). Per pair: what moves (documents, ' +
    'messages by status, revisions, bytes), the mail folders, and per principal the inbox role, the project role ' +
    'before/after (inbox-only members become guest, never editor), the membership that would be added, messages ' +
    'readable before/after, and flags (gains_oversight: a project admin would read historic mail). blocked lists ' +
    'why a pair cannot be applied. Apply is `brain migrate-spaces --apply` on the server host only.',
  input: z
    .object({
      pairs: z.array(z.object({ project: SlugSchema, inbox: SlugSchema }).strict()).min(1).max(20),
      accept_oversight: z.boolean().optional(),
    })
    .strict(),
  output: z.object({
    dry_run: z.boolean(),
    ok: z.boolean(),
    pairs: z.array(
      z.object({
        project: z.string(),
        inbox: z.string(),
        ok: z.boolean(),
        blocked: z.array(z.string()),
        counts: z.object({
          documents: z.number().int(),
          live_documents: z.number().int(),
          messages: z.number().int(),
          pending: z.number().int(),
          received: z.number().int(),
          done: z.number().int(),
          declined: z.number().int(),
          agent_cards: z.number().int(),
          revisions: z.number().int(),
          proposals: z.number().int(),
          bytes: z.number().int(),
        }),
        mail_folders: z.array(z.string()),
        members: z.array(
          z.object({
            name: z.string(),
            kind: z.enum(['human', 'agent', 'system']),
            external: z.boolean(),
            inbox_role: LadderSchema,
            project_before: LadderSchema,
            project_after: LadderSchema,
            grant_added: RoleSchema.nullable(),
            own_mail: z.number().int(),
            mail_before: z.number().int(),
            mail_after: z.number().int(),
            flags: z.array(z.string()),
            blocks: z.array(z.string()),
          }),
        ),
      }),
    ),
  }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => previewSpacesMigration(ctx.core, i.pairs, { acceptOversight: i.accept_oversight === true }),
  render: (o) => renderSpacesMigration(o as SpacesMigration),
  isolation: ADMIN_ISOLATION,
});
