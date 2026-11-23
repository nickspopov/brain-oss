// admin_group_create | update | delete | members_set | list.
import { z } from 'zod';
import { adminGroupCreate, adminGroupDelete, adminGroupList, adminGroupMembersSet, adminGroupUpdate } from '../../core/admin.js';
import { defineOp } from '../define.js';
import { ADMIN, ADMIN_ISOLATION, GroupViewSchema, NameSchema, RequestId, groupOut } from './common.js';

const Out = z.object({ group: GroupViewSchema });
const Description = z.string().max(2000);

export const adminGroupCreateOp = defineOp({
  name: 'admin_group_create',
  summary: 'Create a group of principals (admin).',
  description: 'Creates an empty flat group. Grants given to a group apply to all its members.',
  input: z.object({ name: NameSchema, description: Description.optional(), ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ group: groupOut(adminGroupCreate(ctx, i.name, i.description ?? '')) }),
  isolation: ADMIN_ISOLATION,
});

export const adminGroupUpdateOp = defineOp({
  name: 'admin_group_update',
  summary: 'Rename a group or change its description (admin).',
  description: 'Renames a group (new_name) or changes its description. The system group all-agents cannot be renamed.',
  input: z.object({ name: NameSchema, new_name: NameSchema.optional(), description: Description.optional(), ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ group: groupOut(adminGroupUpdate(ctx, i.name, { name: i.new_name, description: i.description })) }),
  isolation: ADMIN_ISOLATION,
});

export const adminGroupDeleteOp = defineOp({
  name: 'admin_group_delete',
  summary: 'Delete a group with its grants (admin).',
  description: 'Deletes a group, its membership and every grant given to it. all-agents cannot be deleted.',
  input: z.object({ name: NameSchema, ...RequestId }).strict(),
  output: z.object({ deleted: z.literal(true) }),
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => {
    adminGroupDelete(ctx, i.name);
    return { deleted: true as const };
  },
  isolation: ADMIN_ISOLATION,
});

export const adminGroupMembersSetOp = defineOp({
  name: 'admin_group_members_set',
  summary: 'Set the full member list of a group (admin).',
  description:
    'Replaces the members of a group with the given principal names. Takes effect from the next call of each member. ' +
    'Membership of all-agents is computed and cannot be set.',
  input: z.object({ name: NameSchema, members: z.array(NameSchema).max(1000), ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ group: groupOut(adminGroupMembersSet(ctx, i.name, i.members)) }),
  isolation: ADMIN_ISOLATION,
});

export const adminGroupListOp = defineOp({
  name: 'admin_group_list',
  summary: 'List groups with members (admin).',
  description: 'Lists groups with description and member names; all-agents shows its computed membership.',
  input: z.object({}).strict(),
  output: z.object({ groups: z.array(GroupViewSchema) }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx) => ({ groups: adminGroupList(ctx).map(groupOut) }),
  isolation: ADMIN_ISOLATION,
});
