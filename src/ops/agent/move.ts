// move: a document within a space; folders and other spaces are not supported.
import { z } from 'zod';
import { moveDocument } from '../../core/documents.js';
import { defineOp } from '../define.js';
import { MessageSchema, PathSchema, SlugSchema } from '../types.js';
import { addressedDocRefs, docRef, DocResultSchema, ExpectedRev, recheckDocReplay, refOf, writeCtx, writeMeta } from './common.js';

export const moveOp = defineOp({
  name: 'move',
  summary: 'Move or rename a document within its space.',
  description:
    'Moves a document (by id or space+path) to to_path in the same space; the id and the history stay. You need write ' +
    'on both the old and the new path. If to_path is taken you get conflict (reason "path_taken"). Paths are ' +
    'case-insensitive: changing only the letter case is a valid rename. Moving to another space and moving whole folders are not supported in v1 (to_space must be omitted or equal the current space).',
  input: z
    .object({
      ...docRef,
      to_space: SlugSchema.optional(),
      to_path: PathSchema,
      expected_rev: ExpectedRev.optional(),
      message: MessageSchema.optional(),
      ...writeMeta,
    })
    .strict(),
  output: DocResultSchema,
  effect: 'write',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, input) =>
    moveDocument(writeCtx(ctx, 'move', input.request_id), {
      ref: refOf(input),
      toSpace: input.to_space,
      toPath: input.to_path,
      expectedRev: input.expected_rev,
      message: input.message ?? '',
    }),
  replayCheck: recheckDocReplay,
  render: (o) => `Moved: ${o.doc.space}/${o.doc.path} rev ${o.doc.rev} (id ${o.doc.id})`,
  isolation: { kind: 'inputs', build: (hidden) => ({ addressed: addressedDocRefs(hidden, { to_path: 'isolation-moved.md' }), broad: [] }) },
});
