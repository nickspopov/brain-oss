// profile_get, profile_update: one profile per agent or person (optional `_agents/<name>.md`
// agent cards are ordinary documents and only feed suggestions). Your own
// profile in full; a co-member's minimal profile only while you share a space; anyone else is not_found.
import { z } from 'zod';
import { CONTACT_MAX, DISPLAY_NAME_MAX, profileGet, profileUpdate, WHAT_I_DO_MAX, type FullProfile, type MinimalProfile } from '../../core/profiles.js';
import { defineOp } from '../define.js';
import { RequestIdSchema, toIso } from '../types.js';

const ProfileSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  kind: z.enum(['human', 'agent']),
  what_i_do: z.string().nullable(),
  contact: z.string().nullable(),
  manager: z.string().nullable(),
  external: z.boolean(),
  active_today: z.boolean(),
  /** Your own profile only. */
  harness: z.string().nullable().optional(),
  last_seen: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
type Profile = z.input<typeof ProfileSchema>;

function out(p: MinimalProfile | FullProfile): Profile {
  const base: Profile = {
    name: p.name,
    display_name: p.display_name,
    kind: p.kind,
    what_i_do: p.what_i_do,
    contact: p.contact,
    manager: p.manager,
    external: p.external,
    active_today: p.active_today,
  };
  if ('harness' in p) {
    base.harness = p.harness;
    base.last_seen = p.last_seen === null ? null : toIso(p.last_seen);
    base.updated_at = p.updated_at === null ? null : toIso(p.updated_at);
  }
  return base;
}

function render(o: { profile: z.output<typeof ProfileSchema>; self: boolean }): string {
  const p = o.profile;
  const lines = [`${p.display_name} (${p.name}, ${p.kind}${p.external ? ', external' : ''})`];
  lines.push(`What it does: ${p.what_i_do ?? '(not filled in)'}`);
  lines.push(`How to reach: ${p.contact ?? '(not filled in)'}`);
  if (p.manager) lines.push(`Managed by: ${p.manager}`);
  lines.push(p.active_today ? 'Active today.' : 'Not active today.');
  if (o.self && (!p.what_i_do || !p.contact)) lines.push('Fill in your profile: profile_update(what_i_do="…", contact="…").');
  return lines.join('\n');
}

export const profileGetOp = defineOp({
  name: 'profile_get',
  summary: 'A profile: yours (no name), or of someone you share a space with.',
  description:
    'Without name: your own profile. With name: the minimal profile (display name, what it does, how to reach it, ' +
    'manager, external, active today) of a person or agent you share a space with; not_found otherwise.',
  input: z.object({ name: z.string().min(1).max(63).optional() }).strict(),
  output: z.object({ profile: ProfileSchema, self: z.boolean() }),
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, i) => {
    const r = profileGet(ctx, i.name);
    return { profile: out(r.profile), self: r.self };
  },
  render,
  // The hidden space's member may legitimately share another space with the caller: the canary test for
  // profiles (test/server/profiles.test.ts) covers names; here, the own profile must carry nothing hidden.
  isolation: { kind: 'inputs', build: () => ({ addressed: [], broad: [{}] }) },
});

export const profileUpdateOp = defineOp({
  name: 'profile_update',
  summary: 'Fill in your own profile: what you do, how to reach you.',
  description:
    'Edits your own profile, shown to those you share a space with (and in the To picker). what_i_do: one line, ' +
    `at most ${WHAT_I_DO_MAX} characters. contact: how to reach you and your response times, at most ${CONTACT_MAX} ` +
    `characters. display_name: at most ${DISPLAY_NAME_MAX}. null or "" clears a field. No secrets.`,
  input: z
    .object({
      display_name: z.string().max(DISPLAY_NAME_MAX).optional(),
      what_i_do: z.string().max(WHAT_I_DO_MAX * 2).nullable().optional(),
      contact: z.string().max(CONTACT_MAX * 2).nullable().optional(),
      request_id: RequestIdSchema.optional(),
    })
    .strict(),
  output: z.object({ profile: ProfileSchema, self: z.boolean() }),
  effect: 'write',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, i) => ({ profile: out(profileUpdate(ctx, i)), self: true }),
  render,
  isolation: { kind: 'not_applicable', reason: 'edits only the caller’s own profile; takes no locator of anything else' },
});
