// list: the space tree; only what the caller can read is visible.
import { z } from 'zod';
import { readableAgentsMd, visibleSpaces } from '../../core/guard.js';
import { listDocuments } from '../../core/revisions.js';
import { invalidInput } from '../../core/errors.js';
import { defineOp } from '../define.js';
import { CursorSchema, DocInfoSchema, PathSchema, RoleSchema, SlugSchema } from '../types.js';
import { quoted } from './llmtext.js';

const Entry = z.union([
  z.object({ type: z.literal('folder'), path: z.string(), children: z.number().int() }),
  DocInfoSchema.extend({ type: z.literal('doc') }),
]);

/** Compact overview of the caller's spaces: `list` without `space`. */
const SpaceOverview = z.object({
  slug: z.string(),
  role: RoleSchema,
  description: z.string(),
  agents_md: z.boolean(),
});

export const listOp = defineOp({
  name: 'list',
  summary: 'List folders and documents of a space, or your spaces when space is omitted.',
  description:
    'Without space: lists the spaces you can see (slug, your role, description, whether you can read its AGENTS.md); ' +
    'call list again with one of those slugs. With space: lists the tree of that space: folders first, then documents, sorted by path. path is a folder (omit for the root); ' +
    'depth 1–5 (default 1) controls how deep to go. children counts the direct children of a folder that you can see. ' +
    'include_deleted adds deleted documents (the trash) with deleted: true. include_messages: false leaves out ' +
    'messages (use handoff_inbox for them). Paginate with cursor/next_cursor.',
  input: z
    .object({
      space: SlugSchema.optional(),
      path: PathSchema.optional(),
      depth: z.number().int().min(1).max(5).optional(),
      include_deleted: z.boolean().optional(),
      include_messages: z.boolean().optional(),
      cursor: CursorSchema.optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({ entries: z.array(Entry), next_cursor: z.string().optional(), spaces: z.array(SpaceOverview).optional() }),
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) => {
    if (input.space === undefined) {
      if (input.path !== undefined) throw invalidInput('space', 'required when path is given');
      if (input.cursor !== undefined) throw invalidInput('space', 'required when cursor is given');
      const spaces = visibleSpaces(ctx)
        .map(({ space: s, role }) => ({ slug: s.slug, role, description: s.description, agents_md: readableAgentsMd(ctx, s) !== undefined }))
        .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      return { entries: [], spaces };
    }
    return listDocuments(ctx, {
      space: input.space,
      path: input.path,
      depth: input.depth ?? 1,
      includeDeleted: input.include_deleted ?? false,
      includeMessages: input.include_messages ?? true,
      cursor: input.cursor,
      limit: input.limit ?? 100,
    });
  },
  render: (o) =>
    o.spaces !== undefined
      ? renderSpaces(o.spaces)
      : o.entries.length === 0
      ? 'Empty.'
      : o.entries
          .map((e) => (e.type === 'folder' ? `${e.path}/ (${e.children})` : `${e.path} rev ${e.rev}${e.deleted ? ' [deleted]' : ''} title ${quoted(e.title)}`))
          .join('\n') + (o.next_cursor ? `\nnext_cursor: ${o.next_cursor}` : ''),
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: [
        { input: { space: hidden.space }, missing: { space: 'no-such-space' } },
        { input: { space: hidden.space, depth: 5, include_deleted: true }, missing: { space: 'no-such-space', depth: 5, include_deleted: true } },
      ],
      broad: [],
    }),
  },
});

function renderSpaces(spaces: z.infer<typeof SpaceOverview>[]): string {
  if (spaces.length === 0) return 'No spaces are visible to you.';
  return (
    'Your spaces (call list with space to see its tree):\n' +
    spaces
      .map((s) => `${s.slug} (${s.role})${s.description ? `: ${s.description.replace(/\s+/g, ' ').trim()}` : ''}${s.agents_md ? ` — read ${s.slug}/AGENTS.md first` : ''}`)
      .join('\n')
  );
}
