// revert: a new revision with the body of revision to_rev; earlier revisions do not change.
import { z } from 'zod';
import { revertDocument } from '../../core/documents.js';
import { defineOp } from '../define.js';
import {
  addressedDocRefs,
  docRef,
  ExpectedRev,
  recheckDocReplay,
  renderWrite,
  refOf,
  requiredMessage,
  RevNumber,
  writeCtx,
  writeMeta,
  WriteResultSchema,
} from './common.js';

export const revertOp = defineOp({
  name: 'revert',
  summary: 'Roll a document back to the content of an earlier revision (as a new revision).',
  description:
    'Creates a new revision of kind "revert" whose content equals revision to_rev; nothing in the history is changed ' +
    'or removed. A deleted document is restored first. expected_rev (optional) guards against concurrent writes. ' +
    'message says why (required). If this write needs review for you (protected path, role propose, or the space review_mode), it is not applied but saved as a proposal: the answer is status "proposed" with proposal (a success, not an error); a space admin accepts or rejects it.',
  input: z
    .object({ ...docRef, to_rev: RevNumber, expected_rev: ExpectedRev.optional(), message: requiredMessage, ...writeMeta })
    .strict(),
  output: WriteResultSchema,
  effect: 'write',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, input) =>
    revertDocument(writeCtx(ctx, 'revert', input.request_id), refOf(input), input.to_rev, input.expected_rev, input.message),
  replayCheck: recheckDocReplay,
  render: (o) => renderWrite('Reverted', o),
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({ addressed: addressedDocRefs(hidden, { to_rev: 1, message: 'isolation' }), broad: [] }),
  },
});
