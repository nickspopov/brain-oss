// restore: bring back a deleted document with its history.
import { z } from 'zod';
import { restoreDocument } from '../../core/documents.js';
import { defineOp } from '../define.js';
import { IdSchema, MessageSchema, PathSchema } from '../types.js';
import { DocResultSchema, MISSING_ID, recheckDocReplay, writeCtx, writeMeta } from './common.js';

export const restoreOp = defineOp({
  name: 'restore',
  summary: 'Restore a deleted document (optionally under a new path).',
  description:
    'Restores a deleted document by id as a new revision of kind "restore"; the history comes back with it. If its ' +
    'old path is taken by another document you get conflict (reason "path_taken"): pass path to restore it elsewhere.',
  input: z.object({ id: IdSchema, path: PathSchema.optional(), message: MessageSchema.optional(), ...writeMeta }).strict(),
  output: DocResultSchema,
  effect: 'write',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, input) => restoreDocument(writeCtx(ctx, 'restore', input.request_id), input.id, input.path, input.message ?? ''),
  replayCheck: recheckDocReplay,
  render: (o) => `Restored: ${o.doc.space}/${o.doc.path} rev ${o.doc.rev} (id ${o.doc.id})`,
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({ addressed: hidden.docIds.map((id) => ({ input: { id }, missing: { id: MISSING_ID } })), broad: [] }),
  },
});
