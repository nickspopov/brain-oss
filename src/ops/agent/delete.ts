// delete: a delete revision; the document leaves list, the path is freed; restore brings it back.
import { z } from 'zod';
import { deleteDocument } from '../../core/documents.js';
import { defineOp } from '../define.js';
import { MessageSchema } from '../types.js';
import { addressedDocRefs, docRef, DocResultSchema, ExpectedRev, recheckDocReplay, refOf, writeCtx, writeMeta } from './common.js';

export const deleteOp = defineOp({
  name: 'delete',
  summary: 'Delete a document (soft: it goes to the trash with its history).',
  description:
    'Deletes a document by id or space+path. This is a new revision of kind "delete": the history stays, the path ' +
    'becomes free, the document disappears from list and search. restore(id) brings it back. expected_rev is optional.',
  input: z.object({ ...docRef, expected_rev: ExpectedRev.optional(), message: MessageSchema.optional(), ...writeMeta }).strict(),
  output: DocResultSchema,
  effect: 'write',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, input) => deleteDocument(writeCtx(ctx, 'delete', input.request_id), refOf(input), input.expected_rev, input.message ?? ''),
  replayCheck: recheckDocReplay,
  render: (o) => `Deleted: ${o.doc.space}/${o.doc.path} rev ${o.doc.rev} (id ${o.doc.id})`,
  isolation: { kind: 'inputs', build: (hidden) => ({ addressed: addressedDocRefs(hidden), broad: [] }) },
});
