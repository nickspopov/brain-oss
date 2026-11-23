// admin_purge: permanent erasure of a document or of the bodies of individual revisions.
import { z } from 'zod';
import { adminPurge } from '../../core/purge.js';
import { defineOp } from '../define.js';
import { IdSchema } from '../types.js';
import { ADMIN, ADMIN_ISOLATION } from './common.js';

export const adminPurgeOp = defineOp({
  name: 'admin_purge',
  summary: 'Erase a document or the bodies of some of its revisions for good (secret leak runbook).',
  description:
    'Irreversible. Without revs the whole document is erased: its rows, revisions, Yjs body, proposals, ' +
    'document grants, search index entry, and bodies no one else references. With revs only the bodies of those ' +
    'non-head revisions are erased; the revision rows stay with purged = true and read/diff/revert of them answer ' +
    'purged. A revision whose body equals the head cannot be purged (conflict head_body): write a fixed version ' +
    'first. Temporary exports of the space are dropped. Run `brain vacuum` afterwards to rewrite the database ' +
    'file; backups made earlier still contain the data (rotate them). reason goes to the audit log.',
  input: z
    .object({
      id: IdSchema,
      revs: z.array(z.number().int().min(1)).min(1).max(1000).optional(),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  output: z.object({
    id: z.string(),
    scope: z.enum(['document', 'revisions']),
    revs: z.array(z.number().int()).optional(),
    bodies_deleted: z.number().int(),
    bodies_kept: z.number().int(),
    exports_dropped: z.number().int(),
  }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, input) => adminPurge(ctx, { id: input.id, revs: input.revs, reason: input.reason }),
  auditDetail: (input, o) => ({ reason: input.reason.slice(0, 300), scope: o.scope, ...(o.revs ? { revs: o.revs } : {}) }),
  auditTarget: (o) => ({ doc_id: o.id }),
  render: (o) =>
    o.scope === 'document'
      ? `Document ${o.id} erased (${o.bodies_deleted} bodies deleted). Run brain vacuum.`
      : `Revisions ${o.revs?.join(', ')} of ${o.id} purged (${o.bodies_deleted} bodies deleted, ${o.bodies_kept} still referenced). Run brain vacuum.`,
  isolation: ADMIN_ISOLATION,
});
