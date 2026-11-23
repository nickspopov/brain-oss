// diff: the difference between two text revisions. `from: "seen"` was cut from v1.
import { z } from 'zod';
import { diffOf } from '../../core/revisions.js';
import { defineOp } from '../define.js';
import { addressedDocRefs, docRef, refOf, RevNumber } from './common.js';
import { dataBlock, newNonce } from './llmtext.js';

export const diffOp = defineOp({
  name: 'diff',
  summary: 'Unified diff between two revisions of a text document.',
  description:
    'Compares revision from with revision to (default "head") of a text document and returns a unified diff and the ' +
    'number of added and removed lines. format "stat" returns only the counts. Very large diffs are cut (truncated); ' +
    'when the revisions differ in more than 1000 lines no diff text is returned, truncated is true and the counts are ' +
    'an upper estimate (read both revisions instead).',
  input: z
    .object({
      ...docRef,
      from: RevNumber,
      to: z.union([RevNumber, z.literal('head')]).optional(),
      format: z.enum(['unified', 'stat']).optional(),
    })
    .strict(),
  output: z.object({
    from: z.number().int(),
    to: z.number().int(),
    diff: z.string().optional(),
    added: z.number().int(),
    removed: z.number().int(),
    truncated: z.boolean(),
  }),
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) => diffOf(ctx, refOf(input), input.from, input.to ?? 'head', input.format ?? 'unified'),
  render: (o) =>
    [
      `rev ${o.from} → rev ${o.to}: +${o.added} −${o.removed}${o.truncated ? ' (truncated)' : ''}`,
      ...(o.diff ? dataBlock(newNonce(), 'DIFF', 'the authors of these revisions (see history)', o.diff) : []),
    ].join('\n'),
  isolation: { kind: 'inputs', build: (hidden) => ({ addressed: addressedDocRefs(hidden, { from: 1 }), broad: [] }) },
});
