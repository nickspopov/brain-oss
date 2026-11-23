// write: create a document or replace its body, checking expected_rev.
import { z } from 'zod';
import { writeDocument } from '../../core/documents.js';
import { defineOp } from '../define.js';
import { PathSchema, SlugSchema } from '../types.js';
import { allowSecretField, ExpectedRev, recheckDocReplay, renderWrite, requiredMessage, writeCtx, writeMeta, WriteResultSchema } from './common.js';

export const writeOp = defineOp({
  name: 'write',
  summary: 'Create a document or replace its whole content (optimistic concurrency via expected_rev).',
  description:
    'Writes the full content of the document at space/path. Paths are case-insensitive (a.md and A.md are the same ' +
    'document). To create, omit expected_rev (or pass 0). To update an ' +
    'existing document you must pass expected_rev = the rev you read; if someone wrote in between you get ' +
    'conflict (reason "stale") with the current text and a diff, and nothing is written: merge and retry with the new ' +
    'rev. There is no blind overwrite and no force flag. Pass request_id to make retries safe: the same request_id ' +
    'with the same input returns the stored response without writing twice. content is UTF-8 text (Markdown with ' +
    'optional YAML frontmatter); content_base64 stores a binary file up to 1 MB. message says why (required). ' +
    'Content, path and message are checked for secrets (API keys, tokens, private keys): a hit answers ' +
    'secret_detected with the rule and position, and nothing is written — remove the secret and retry. ' +
    'allow_secret is reserved for the human superadmin in the UI. If this write needs review for you (protected path, role propose, or the space review_mode), it is not applied but saved as a proposal: the answer is status "proposed" with proposal (a success, not an error); a space admin accepts or rejects it.',
  input: z
    .object({
      space: SlugSchema,
      path: PathSchema,
      content: z.string().optional(),
      content_base64: z.string().optional(),
      expected_rev: ExpectedRev.optional(),
      ttl_days: z.number().int().min(1).max(3650).optional(),
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
    writeDocument(writeCtx(ctx, 'write', input.request_id, input.allow_secret), {
      space: input.space,
      path: input.path,
      content: input.content,
      contentBase64: input.content_base64,
      expectedRev: input.expected_rev,
      ttlDays: input.ttl_days,
      message: input.message,
    }),
  replayCheck: recheckDocReplay,
  render: (o) => renderWrite('Committed', o),
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: [
        ...hidden.paths.map((path) => ({
          input: { space: hidden.space, path, content: 'x\n', expected_rev: 1, message: 'isolation' },
          missing: { space: 'no-such-space', path, content: 'x\n', expected_rev: 1, message: 'isolation' },
        })),
        {
          input: { space: hidden.space, path: 'isolation-new.md', content: 'x\n', message: 'isolation' },
          missing: { space: 'no-such-space', path: 'isolation-new.md', content: 'x\n', message: 'isolation' },
        },
      ],
      broad: [],
    }),
  },
});
