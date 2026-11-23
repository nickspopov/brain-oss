// admin_principal_create | update | disable | enable | list.
import { z } from 'zod';
import { adminPrincipalCreate, adminPrincipalList, adminPrincipalSetDisabled, adminPrincipalUpdate } from '../../core/admin.js';
import { CONTACT_MAX, WHAT_I_DO_MAX } from '../../core/profiles.js';
import { defineOp } from '../define.js';
import { TrustSchema } from '../types.js';
import { ADMIN, ADMIN_ISOLATION, LimitsInputSchema, NameSchema, PrincipalViewSchema, RequestId, principalOut } from './common.js';

const OwnerLabel = z.string().trim().min(1).max(100);

const Out = z.object({ principal: PrincipalViewSchema });
const Password = z.string().min(1).max(1024);

export const adminPrincipalCreateOp = defineOp({
  name: 'admin_principal_create',
  summary: 'Create an agent or a human (admin).',
  description:
    'Creates a principal. Agents authenticate with tokens (admin_token_issue); humans may get a password for the UI. ' +
    'trust is the trust level of the text it writes (admin, trusted, limited). admin: true grants the admin capability ' +
    '(only a superadmin may set it). Superadmins are created only with the CLI. external: true makes an agent of ' +
    'another person (owner_label names that person; limits override the defaults 20 messages/day, 8 KB body, ' +
    '5 open per recipient, 30-day tokens; null = no limit). Only a human can create, change, grant or issue tokens ' +
    'to an external agent.',
  input: z
    .object({
      name: NameSchema,
      kind: z.enum(['agent', 'human']),
      display_name: z.string().min(1).max(200).optional(),
      trust: TrustSchema,
      owner: NameSchema.optional(),
      harness: z.string().min(1).max(64).optional(),
      password: Password.optional(),
      admin: z.boolean().optional(),
      external: z.boolean().optional(),
      owner_label: OwnerLabel.optional(),
      limits: LimitsInputSchema.optional(),
      ...RequestId,
    })
    .strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ principal: principalOut(adminPrincipalCreate(ctx, i)) }),
  isolation: ADMIN_ISOLATION,
});

export const adminPrincipalUpdateOp = defineOp({
  name: 'admin_principal_update',
  summary: 'Change display name, trust, owner, harness, password or admin capability (admin).',
  description:
    'Updates a principal found by name. owner and harness accept null to clear. Changing a superadmin or ' +
    'the admin capability requires a superadmin. external, owner_label and limits (and any change of an external ' +
    'agent) require a human. what_i_do and contact edit its profile (null clears).',
  input: z
    .object({
      name: NameSchema,
      display_name: z.string().min(1).max(200).optional(),
      trust: TrustSchema.optional(),
      owner: NameSchema.nullable().optional(),
      harness: z.string().min(1).max(64).nullable().optional(),
      password: Password.optional(),
      admin: z.boolean().optional(),
      external: z.boolean().optional(),
      owner_label: OwnerLabel.nullable().optional(),
      limits: LimitsInputSchema.optional(),
      /** Profile fields (one line; how to reach it and response times). */
      what_i_do: z.string().max(WHAT_I_DO_MAX).nullable().optional(),
      contact: z.string().max(CONTACT_MAX).nullable().optional(),
      ...RequestId,
    })
    .strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => {
    const { name, request_id: _r, ...patch } = i;
    return { principal: principalOut(adminPrincipalUpdate(ctx, name, patch)) };
  },
  isolation: ADMIN_ISOLATION,
});

export const adminPrincipalDisableOp = defineOp({
  name: 'admin_principal_disable',
  summary: 'Disable a principal: all its tokens and sessions stop working at once (admin).',
  description:
    'Disables a principal. Every token and UI session of it is refused from the very next request. ' +
    'The last active superadmin cannot be disabled.',
  input: z.object({ name: NameSchema, ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ principal: principalOut(adminPrincipalSetDisabled(ctx, i.name, true)) }),
  isolation: ADMIN_ISOLATION,
});

export const adminPrincipalEnableOp = defineOp({
  name: 'admin_principal_enable',
  summary: 'Enable a disabled principal (admin).',
  description: 'Enables a principal again; its tokens that are not revoked or expired work again.',
  input: z.object({ name: NameSchema, ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ principal: principalOut(adminPrincipalSetDisabled(ctx, i.name, false)) }),
  isolation: ADMIN_ISOLATION,
});

export const adminPrincipalListOp = defineOp({
  name: 'admin_principal_list',
  summary: 'List principals (admin).',
  description: 'Lists humans and agents with kind, trust, admin capability, owner and status; include_disabled adds disabled ones.',
  input: z.object({ include_disabled: z.boolean().optional() }).strict(),
  output: z.object({ principals: z.array(PrincipalViewSchema) }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => ({ principals: adminPrincipalList(ctx, i.include_disabled ?? false).map(principalOut) }),
  isolation: ADMIN_ISOLATION,
});
