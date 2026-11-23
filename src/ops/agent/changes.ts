// changes: what changed after the cursor; the caller's own edits are hidden by default.
import { z } from 'zod';
import { changes } from '../../core/feed.js';
import { defineOp } from '../define.js';
import { CursorSchema, RevInfoSchema, SlugSchema } from '../types.js';
import { quoted } from './llmtext.js';

export const ChangeItemSchema = RevInfoSchema.extend({
  doc: z.object({ id: z.string(), space: z.string(), path: z.string(), title: z.string() }),
});

/** Feed line: the author's message and title in JSON quotes, on one line. */
export function renderChange(c: z.infer<typeof ChangeItemSchema>): string {
  return (
    `${c.created_at} ${c.doc.space}/${c.doc.path} rev ${c.rev} ${c.kind} by ${c.author.name} (${c.author.trust})` +
    `${c.attention ? ' [attention]' : ''} title ${quoted(c.doc.title)}${c.message ? ` message ${quoted(c.message)}` : ''}`
  );
}

export const changesOp = defineOp({
  name: 'changes',
  summary: 'What changed since your last visit (other authors by default).',
  description:
    'Returns revisions made after a cursor, oldest first, in documents you can read (by their current location). ' +
    'The server keeps a cursor per caller. Loop: r = changes() → handle r.changes → next time changes({since: r.cursor}). ' +
    'Without since the saved cursor is used and not moved; with since the cursor is saved first, so a lost response ' +
    'can be fetched again. Your own changes are skipped unless include_own. Filter by spaces or attention_only ' +
    '(edits in executable spaces by non-admin authors). has_more means call again with the returned cursor. ' +
    'limit 100 by default, max 500.',
  input: z
    .object({
      since: CursorSchema.optional(),
      spaces: z.array(SlugSchema).min(1).max(50).optional(),
      include_own: z.boolean().optional(),
      attention_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({ changes: z.array(ChangeItemSchema), cursor: z.string(), has_more: z.boolean() }),
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) =>
    changes(ctx, {
      since: input.since,
      spaces: input.spaces,
      includeOwn: input.include_own ?? false,
      attentionOnly: input.attention_only ?? false,
      limit: input.limit ?? 100,
    }),
  render: (o) =>
    (o.changes.length === 0 ? 'No changes.' : o.changes.map(renderChange).join('\n')) +
    `\ncursor: ${o.cursor}${o.has_more ? ' (has_more: call again with since = cursor)' : ''}`,
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: [
        { input: { spaces: [hidden.space] }, missing: { spaces: ['no-such-space'] } },
        { input: { spaces: [hidden.space], include_own: true }, missing: { spaces: ['no-such-space'], include_own: true } },
      ],
      broad: [{}, { include_own: true }, { attention_only: true }],
    }),
  },
});
