// history: document revisions, newest first.
import { z } from 'zod';
import { historyOf } from '../../core/revisions.js';
import { defineOp } from '../define.js';
import { CursorSchema, RevInfoSchema } from '../types.js';
import { addressedDocRefs, docRef, refOf } from './common.js';
import { quoted } from './llmtext.js';

export const historyOp = defineOp({
  name: 'history',
  summary: 'List the revisions of a document, newest first.',
  description:
    'Returns the revisions of a document (by id or space+path; deleted documents by id): rev, kind (create, update, ' +
    'move, delete, restore, revert…), author with trust, message, time, size and content hash. Revisions never change; ' +
    'read a past one with read(rev) and roll back with revert(to_rev). Paginate with cursor/next_cursor (limit 50, max 200).',
  input: z
    .object({
      ...docRef,
      cursor: CursorSchema.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({ revisions: z.array(RevInfoSchema), next_cursor: z.string().optional() }),
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) => historyOf(ctx, refOf(input), input.cursor, input.limit ?? 50),
  render: (o) =>
    o.revisions
      .map((r) => `rev ${r.rev} ${r.kind} by ${r.author.name} (${r.author.trust}) ${r.created_at}${r.message ? ` message ${quoted(r.message)}` : ''}`)
      .join('\n') + (o.next_cursor ? `\nnext_cursor: ${o.next_cursor}` : ''),
  isolation: { kind: 'inputs', build: (hidden) => ({ addressed: addressedDocRefs(hidden), broad: [] }) },
});
