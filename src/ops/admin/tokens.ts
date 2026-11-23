// admin_token_issue | revoke | list. The plaintext token is shown once and not
// saved for idempotency.
import { z } from 'zod';
import { adminTokenIssue, adminTokenList, adminTokenRevoke } from '../../core/admin.js';
import { defineOp } from '../define.js';
import { IdSchema } from '../types.js';
import { ADMIN, ADMIN_ISOLATION, NameSchema, RequestId, TokenViewSchema, tokenOut } from './common.js';

export const adminTokenIssueOp = defineOp({
  name: 'admin_token_issue',
  summary: 'Issue a token for a principal; the full token is returned once (admin).',
  description:
    'Issues a bearer token (brn_…) for a principal. The full token appears only in this response and is never ' +
    'stored or shown again. days sets the lifetime (default from server config, 90); null means no expiry. ' +
    'Repeating the same request_id does not return the token again: it answers conflict (token_already_issued); ' +
    'issue a new token instead.',
  input: z
    .object({
      principal: NameSchema,
      label: z.string().max(200).optional(),
      days: z.number().int().min(1).max(3650).nullable().optional(),
      ...RequestId,
    })
    .strict(),
  output: z.object({ token: z.string(), info: TokenViewSchema }),
  ...ADMIN,
  idempotent: true,
  withholdReplay: 'token_already_issued',
  handler: (ctx, i) => {
    const t = adminTokenIssue(ctx, i.principal, { label: i.label, days: i.days });
    return { token: t.token, info: tokenOut(t.view) };
  },
  render: (o) => `Token for ${o.info.principal} (shown once): ${o.token}`,
  isolation: ADMIN_ISOLATION,
});

export const adminTokenRevokeOp = defineOp({
  name: 'admin_token_revoke',
  summary: 'Revoke a token by id: refused from the very next request (admin).',
  description: 'Revokes a token. Requests with it are refused from the next one. Revoking twice is harmless.',
  input: z.object({ id: IdSchema, ...RequestId }).strict(),
  output: z.object({ token: TokenViewSchema }),
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => ({ token: tokenOut(adminTokenRevoke(ctx, i.id)) }),
  isolation: ADMIN_ISOLATION,
});

export const adminTokenListOp = defineOp({
  name: 'admin_token_list',
  summary: 'List tokens with prefix, expiry and last use (admin).',
  description: 'Lists tokens (never their values): prefix, label, expiry, revocation and last use. Filter by principal; include_revoked adds revoked ones.',
  input: z.object({ principal: NameSchema.optional(), include_revoked: z.boolean().optional() }).strict(),
  output: z.object({ tokens: z.array(TokenViewSchema) }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => ({ tokens: adminTokenList(ctx, i.principal, i.include_revoked ?? false).map(tokenOut) }),
  isolation: ADMIN_ISOLATION,
});
