// The role ladder and Review presets are words over existing fields. Round-trip over every
// stored combination: a preset reads back as itself and setting it writes exactly the same fields; a
// combination that is no preset reads back as Custom; protected paths are never touched by a preset.
import { describe, expect, it } from 'vitest';
import type { MemberAccess } from '../src/api/types';
import { accessLine, accessWords, ENGINE_ROLE, LADDER_OF, ladderOptions, presetFields, presetOf, approvalScopeOf, requiresApproval } from '../src/lib/roles';

const MODES = ['off', 'limited', 'all'] as const;

describe('Review presets', () => {
  it('round-trip over every combination of review_mode × executable', () => {
    for (const review_mode of MODES) {
      for (const executable of [false, true]) {
        const s = { review_mode, executable };
        const p = presetOf(s);
        if (p === 'custom') {
          // Approval together with flagged edits: no preset; stays as it is.
          expect(review_mode).not.toBe('off');
          expect(executable).toBe(true);
          continue;
        }
        // Reading it back and saving the same preset writes the same fields.
        expect(presetFields(p, approvalScopeOf(s))).toEqual(s);
        expect(presetOf(presetFields(p, approvalScopeOf(s)))).toBe(p);
      }
    }
  });

  it('names: Off, Notify me, Require approval (for limited agents / everyone); Custom otherwise', () => {
    expect(presetOf({ review_mode: 'off', executable: false })).toBe('off');
    expect(presetOf({ review_mode: 'off', executable: true })).toBe('notify');
    expect(presetOf({ review_mode: 'limited', executable: false })).toBe('approval');
    expect(approvalScopeOf({ review_mode: 'limited', executable: false })).toBe('limited');
    expect(presetOf({ review_mode: 'all', executable: false })).toBe('approval');
    expect(approvalScopeOf({ review_mode: 'all', executable: false })).toBe('all');
    expect(presetOf({ review_mode: 'all', executable: true })).toBe('custom');
  });

  it('a preset sets only review_mode and executable (protected paths, TTL and the rest stay)', () => {
    for (const p of ['off', 'notify', 'approval'] as const) expect(Object.keys(presetFields(p, 'all')).sort()).toEqual(['executable', 'review_mode']);
  });

  it('Proposer is offered only when approval is required, or to keep an existing proposer', () => {
    expect(ladderOptions({ messages: false, approval: false })).toEqual(['viewer', 'editor', 'admin']);
    expect(ladderOptions({ messages: true, approval: false })).toEqual(['guest', 'viewer', 'editor', 'admin']);
    expect(ladderOptions({ messages: false, approval: true })).toEqual(['viewer', 'proposer', 'editor', 'admin']);
    // Never silently upgrade a proposer: its own row keeps the option.
    expect(ladderOptions({ messages: false, approval: false, current: 'proposer' })).toContain('proposer');
    // Guest is a personal membership: never for a group.
    expect(ladderOptions({ messages: true, approval: false, group: true })).not.toContain('guest');
    expect(requiresApproval({ review_mode: 'off', executable: true })).toBe(false);
  });

  it('ladder ↔ engine roles are one-to-one', () => {
    for (const [ladder, role] of Object.entries(ENGINE_ROLE)) expect(LADDER_OF[role]).toBe(ladder);
  });
});

const base: MemberAccess = {
  role: 'editor',
  engine_role: 'write',
  messages_only: false,
  external_as_guest: false,
  superadmin: false,
  personal: 'write',
  groups: [],
  overrides: [],
  custom: false,
  visible: true,
  member: true,
};

describe('access in plain words', () => {
  it('"Alpha project — Editor", "General — Guest: its own messages only", via group, Custom access', () => {
    expect(accessLine('Alpha project', base)).toBe('Alpha project — Editor');
    expect(accessLine('General', { ...base, role: 'guest', engine_role: 'guest', messages_only: true, personal: 'guest', visible: false })).toBe('General — Guest: its own messages only');
    expect(accessLine('Alpha project', { ...base, personal: null, groups: [{ name: 'alpha-team', role: 'write' }] })).toBe('Alpha project — Editor (via group alpha-team)');
    expect(accessLine('Shared', { ...base, role: 'viewer', engine_role: 'read', custom: true })).toBe('Shared — Viewer · Custom access');
    expect(accessWords({ ...base, role: 'none', engine_role: 'none', personal: null, custom: true }).role).toBe('Custom access');
    expect(accessLine('Recipes', { ...base, role: 'admin', engine_role: 'admin', superadmin: true, personal: null })).toBe('Recipes — Admin (superadmin)');
  });
});
