// The role ladder and review presets: words for what the engine already decides.
// Nothing here changes a permission: a preset is a way to *set* the existing fields (review_mode,
// executable); a combination that is not a preset reads back as "Custom" and stays as it is.
import type { AdminSpace, Ladder, MemberAccess, Role } from '../api/types';
import { tx } from '../i18n';

export const LADDER_LABEL: Record<Ladder, string> = tx.roles.ladder;

/** Ladder name → the role the engine stores (Guest → guest, Viewer → read, Editor → write, Admin → admin). */
export const ENGINE_ROLE: Record<Exclude<Ladder, 'none'>, Role> = { guest: 'guest', viewer: 'read', proposer: 'propose', editor: 'write', admin: 'admin' };

export const LADDER_OF: Record<Role, Ladder> = { none: 'none', guest: 'guest', read: 'viewer', propose: 'proposer', write: 'editor', admin: 'admin' };

/**
 * Roles offered in a role select. Guest only where messages are on (the engine allows it nowhere else);
 * Proposer only when the space requires approval — or when the member already is one, so the select
 * never silently turns a proposer into an Editor.
 */
export function ladderOptions(opts: { messages: boolean; approval: boolean; current?: Ladder | undefined; group?: boolean }): Exclude<Ladder, 'none'>[] {
  const out: Exclude<Ladder, 'none'>[] = [];
  if (opts.messages && !opts.group) out.push('guest');
  out.push('viewer');
  if (opts.approval || opts.current === 'proposer') out.push('proposer');
  out.push('editor', 'admin');
  return out;
}

/** "Editor", "Guest: its own messages only", "Custom access", with "via group x" when that is where it comes from. */
export function accessWords(a: MemberAccess, opts: { self?: 'its' | 'their' } = {}): { role: string; note: string | null; via: string | null } {
  const its = opts.self ?? 'its';
  const via = a.superadmin
    ? tx.roles.viaSuperadmin
    : a.personal === null && a.groups.length > 0
      ? tx.roles.viaGroups(a.groups.map((g) => g.name).join(', '))
      : null;
  if (a.messages_only) return { role: LADDER_LABEL.guest, note: tx.roles.guestNote(its), via: a.external_as_guest ? tx.roles.externalGuest : via };
  if (a.role === 'none') return { role: a.custom ? tx.roles.custom : LADDER_LABEL.none, note: a.custom ? tx.roles.customOnly : null, via };
  return { role: LADDER_LABEL[a.role], note: a.custom ? tx.roles.custom : null, via };
}

/** One line for an Access tab: "Alpha project — Editor", "General — Guest: its own messages only". */
export function accessLine(spaceName: string, a: MemberAccess): string {
  const w = accessWords(a);
  const what = a.messages_only ? `${w.role}: ${w.note}` : w.note ? `${w.role} · ${w.note}` : w.role;
  return `${spaceName} — ${what}${w.via ? ` (${w.via})` : ''}`;
}

// --- Review presets ------------------------------------------------------------------------------------

export type Preset = 'off' | 'notify' | 'approval' | 'custom';
export type ApprovalScope = 'limited' | 'all';
type ReviewFields = Pick<AdminSpace, 'review_mode' | 'executable'>;

/** The preset an existing combination is, or "custom" (approval *and* flagged edits). */
export function presetOf(s: ReviewFields): Preset {
  if (s.review_mode === 'off') return s.executable ? 'notify' : 'off';
  return s.executable ? 'custom' : 'approval';
}

export function approvalScopeOf(s: ReviewFields): ApprovalScope {
  return s.review_mode === 'all' ? 'all' : 'limited';
}

/** Fields a preset sets. Protected paths, TTL and the rest are never touched by a preset. */
export function presetFields(p: Exclude<Preset, 'custom'>, scope: ApprovalScope): ReviewFields {
  if (p === 'off') return { review_mode: 'off', executable: false };
  if (p === 'notify') return { review_mode: 'off', executable: true };
  return { review_mode: scope, executable: false };
}

/** Does the space make writes proposals (the Proposer role means something there)? */
export const requiresApproval = (s: ReviewFields): boolean => s.review_mode !== 'off';
