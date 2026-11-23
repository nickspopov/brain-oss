// edit: exact replacement of text fragments, exactly one match each.
import { z } from 'zod';
import { editDocument } from '../../core/documents.js';
import { defineOp } from '../define.js';
import {
  addressedDocRefs,
  allowSecretField,
  docRef,
  ExpectedRev,
  recheckDocReplay,
  renderWrite,
  refOf,
  requiredMessage,
  writeCtx,
  writeMeta,
  WriteResultSchema,
} from './common.js';

/** Up to 50 edits per call. */
export const MAX_EDITS = 50;
const EDIT_TEXT_MAX = 1024 * 1024;

const EditSchema = z
  .object({
    old_text: z.string().min(1).max(EDIT_TEXT_MAX),
    new_text: z.string().max(EDIT_TEXT_MAX),
  })
  .strict();

export const editOp = defineOp({
  name: 'edit',
  summary: 'Replace exact fragments of a text document (each old_text must occur exactly once).',
  description:
    'Edits a text document by id or space+path without resending the whole content. Each edit replaces old_text ' +
    'with new_text; old_text must occur exactly once in the text (after the previous edits of the same call). ' +
    'Edits apply in order and atomically: if any fails, nothing is written and you get edit_failed with ' +
    'edit_index and reason ("not_found", or "ambiguous" with the line numbers of the matches) — add more ' +
    'surrounding text to old_text and retry. Up to 50 edits per call. Without expected_rev the edits apply to the ' +
    'current head: the anchors themselves check that the text is still there, so unrelated edits by others do not ' +
    'conflict; pass expected_rev to require an exact revision. The result is checked like write (size, secrets). ' +
    'message says why (required); request_id makes retries safe. If this write needs review for you (protected path, role propose, or the space review_mode), it is not applied but saved as a proposal: the answer is status "proposed" with proposal (a success, not an error); a space admin accepts or rejects it.',
  input: z
    .object({
      ...docRef,
      edits: z.array(EditSchema).min(1).max(MAX_EDITS),
      expected_rev: ExpectedRev.optional(),
      message: requiredMessage,
      ...allowSecretField,
      ...writeMeta,
    })
    .strict(),
  output: WriteResultSchema,
  effect: 'write',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, input) =>
    editDocument(writeCtx(ctx, 'edit', input.request_id, input.allow_secret), {
      ref: refOf(input),
      edits: input.edits.map((e) => ({ oldText: e.old_text, newText: e.new_text })),
      expectedRev: input.expected_rev,
      message: input.message,
    }),
  replayCheck: recheckDocReplay,
  render: (o) => renderWrite('Committed', o),
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: addressedDocRefs(hidden, { edits: [{ old_text: 'a', new_text: 'b' }], message: 'isolation' }),
      broad: [],
    }),
  },
});
