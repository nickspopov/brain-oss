// admin_space_members, admin_profile_get: read models for the space's Members tab and the
// agent/person page. Presentation over the grant engine only: they change nothing.
import { z } from 'zod';
import { spaceView } from '../../core/admin.js';
import { notFound } from '../../core/errors.js';
import { spaceMembers } from '../../core/members.js';
import { findPrincipal } from '../../core/principals.js';
import { cardsConflict, fullProfile, legacyCards } from '../../core/profiles.js';
import { defineOp } from '../define.js';
import { SlugSchema, toIso } from '../types.js';
import { ADMIN, ADMIN_ISOLATION, MemberAccessSchema, memberAccessOut, NameSchema, SpaceViewSchema, spaceOut } from './common.js';

const KindSchema = z.enum(['human', 'agent', 'system']);

export const adminSpaceMembersOp = defineOp({
  name: 'admin_space_members',
  summary: 'Members of a space with their role on the ladder Guest · Viewer · Editor · Admin (admin).',
  description:
    'Changes nothing. Every principal that is a member of the space (a role ≥ guest, or folder/document access) ' +
    'with its role named on the ladder (read = viewer, propose = proposer, write = editor), how it got it ' +
    '(personal, groups, superadmin), folder/document overrides and custom: true when they contradict that role. ' +
    'can_see: active members who see the space or use its messages. candidates: active people, agents and groups ' +
    'that can be added (all-agents is never offered where it gives nothing). notify: the people who are Admins of ' +
    'the space (they see flagged edits) and webhooks on flagged edits.',
  input: z.object({ space: SlugSchema }).strict(),
  output: z.object({
    space: SpaceViewSchema,
    members: z.array(
      z.object({
        name: z.string(),
        display_name: z.string(),
        kind: KindSchema,
        external: z.boolean(),
        disabled: z.boolean(),
        what_i_do: z.string().nullable(),
        access: MemberAccessSchema,
      }),
    ),
    can_see: z.number().int(),
    candidates: z.array(
      z.object({ type: z.enum(['principal', 'group']), name: z.string(), display_name: z.string(), kind: z.enum(['human', 'agent', 'group']), external: z.boolean() }),
    ),
    notify: z.object({ people: z.array(z.string()), webhooks: z.number().int() }),
  }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => {
    const r = spaceMembers(ctx, i.space);
    return {
      space: spaceOut(spaceView(r.space)),
      members: r.members.map((m) => ({
        name: m.principal.name,
        display_name: m.principal.display_name,
        kind: m.principal.kind,
        external: m.principal.external === 1,
        disabled: m.principal.disabled_at !== null,
        what_i_do: m.principal.what_i_do ?? null,
        access: memberAccessOut(ctx, m.access),
      })),
      can_see: r.can_see,
      candidates: r.candidates,
      notify: r.notify,
    };
  },
  isolation: ADMIN_ISOLATION,
});

const CardSchema = z.object({
  space: z.string(),
  path: z.string(),
  doc_id: z.string(),
  rev: z.number().int(),
  what_i_do: z.string().nullable(),
  contact: z.string().nullable(),
  response_times: z.string().nullable(),
});

export const adminProfileGetOp = defineOp({
  name: 'admin_profile_get',
  summary: 'The full profile of a principal and the fields found in its agent cards (admin).',
  description:
    'Changes nothing. profile: display name, what it does, how to reach it, manager, external, harness, last seen. ' +
    'cards: its `_agents/<name>.md` agent cards (an optional profile file format: ordinary documents) with the fields ' +
    'extracted from them — suggestions only; a human accepts one with admin_principal_update. conflict: true when ' +
    'cards disagree.',
  input: z.object({ name: NameSchema }).strict(),
  output: z.object({
    profile: z.object({
      name: z.string(),
      display_name: z.string(),
      kind: KindSchema,
      what_i_do: z.string().nullable(),
      contact: z.string().nullable(),
      manager: z.string().nullable(),
      external: z.boolean(),
      active_today: z.boolean(),
      harness: z.string().nullable(),
      last_seen: z.string().nullable(),
      updated_at: z.string().nullable(),
      disabled: z.boolean(),
    }),
    cards: z.array(CardSchema),
    conflict: z.boolean(),
  }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => {
    const row = findPrincipal(ctx.core, i.name);
    if (!row) throw notFound();
    const p = fullProfile(ctx.core, row);
    const cards = legacyCards(ctx.core, row);
    return {
      profile: { ...p, kind: row.kind, last_seen: p.last_seen === null ? null : toIso(p.last_seen), updated_at: p.updated_at === null ? null : toIso(p.updated_at) },
      cards,
      conflict: cardsConflict(cards),
    };
  },
  isolation: ADMIN_ISOLATION,
});
