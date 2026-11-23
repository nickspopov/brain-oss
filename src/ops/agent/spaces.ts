// spaces: visible spaces with role and settings; invisible ones do not exist.
import { z } from 'zod';
import { visibleProtectedPaths, visibleSpaces } from '../../core/guard.js';
import { agentsMdOf } from '../../core/revisions.js';
import { defineOp } from '../define.js';
import { RoleSchema } from '../types.js';

const SpaceInfo = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  role: RoleSchema,
  review_mode: z.enum(['off', 'limited', 'all']),
  executable: z.boolean(),
  /** Inbox space: handoff_send/handoff_inbox work here. */
  inbox: z.boolean(),
  ttl_days: z.number().int().optional(),
  protected_paths: z.array(z.string()),
  /** Present (true) only for an archived space; only superadmins see those. */
  archived: z.literal(true).optional(),
  agents_md: z.object({ rev: z.number().int(), content: z.string(), truncated: z.boolean() }).optional(),
});

export const spaces = defineOp({
  name: 'spaces',
  summary: 'List the spaces visible to you with your role and their rules.',
  description:
    'Returns every space you can see: slug, name, description, your role on the whole space (it may be "none" when ' +
    'only a folder or a document inside is open to you), review mode, whether it is executable (edits by non-admins ' +
    'are flagged for a curator), whether it is an inbox space (handoff_send), TTL of documents and protected paths. agents_md carries the space AGENTS.md when ' +
    'you can read it. Takes no input. Prefer start_here.',
  input: z.object({}).strict(),
  output: z.object({ spaces: z.array(SpaceInfo) }),
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx) => ({
    // agents_md only with read access to AGENTS.md itself.
    spaces: visibleSpaces(ctx).map(({ space: s, role }) => {
      const agentsMd = agentsMdOf(ctx, s);
      return {
        slug: s.slug,
        name: s.name,
        description: s.description,
        role,
        review_mode: s.review_mode,
        executable: s.executable === 1,
        inbox: s.inbox === 1,
        ...(s.ttl_days !== null ? { ttl_days: s.ttl_days } : {}),
        protected_paths: visibleProtectedPaths(ctx, s),
        ...(agentsMd ? { agents_md: agentsMd } : {}),
        ...(s.archived_at !== null ? { archived: true as const } : {}),
      };
    }),
  }),
  render: (o) =>
    o.spaces.length === 0
      ? 'No spaces are visible to you.'
      : o.spaces
          .map(
            (s) =>
              `${s.slug} (${s.role}) — ${s.name}${s.description ? `: ${s.description}` : ''}` +
              ` [review ${s.review_mode}${s.executable ? ', executable' : ''}${s.inbox ? ', inbox' : ''}${s.ttl_days ? `, ttl ${s.ttl_days}d` : ''}]`,
          )
          .join('\n'),
  isolation: { kind: 'inputs', build: () => ({ addressed: [], broad: [{}] }) },
});
