// activity: the change feed, newest first, with filters; does not touch the server-side cursor.
import { z } from 'zod';
import { activity } from '../../core/feed.js';
import { defineOp } from '../define.js';
import { CursorSchema, SlugSchema } from '../types.js';
import { ChangeItemSchema, renderChange } from './changes.js';

export const activityOp = defineOp({
  name: 'activity',
  summary: 'Recent changes, newest first, filtered by space or author.',
  description:
    'The change feed in reverse order for browsing and investigations: revisions in documents you can read, newest ' +
    'first, optionally only in one space or by one author (principal name). Messages are left out (see handoff_inbox) ' +
    'unless include_messages is true. Does not move your changes cursor. ' +
    'Paginate with before = next_cursor. limit 50 by default, max 200.',
  input: z
    .object({
      space: SlugSchema.optional(),
      author: z.string().min(1).max(64).optional(),
      before: CursorSchema.optional(),
      limit: z.number().int().min(1).max(200).optional(),
      include_messages: z.boolean().optional().describe('Also list revisions of your messages (default: no; they live in handoff_inbox).'),
    })
    .strict(),
  output: z.object({ items: z.array(ChangeItemSchema), next_cursor: z.string().optional() }),
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) => activity(ctx, { space: input.space, author: input.author, before: input.before, includeMessages: input.include_messages, limit: input.limit ?? 50 }),
  render: (o) =>
    (o.items.length === 0 ? 'No changes.' : o.items.map(renderChange).join('\n')) + (o.next_cursor ? `\nnext_cursor: ${o.next_cursor}` : ''),
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: [{ input: { space: hidden.space }, missing: { space: 'no-such-space' } }],
      broad: [{}, { limit: 200 }],
    }),
  },
});
