// Role resolution algorithm. A pure function with no DB: input is the grants of one space,
// the caller's subjects and the target; output is the role and the grant that decided it.
import type { Role } from '../../store/types.js';

/**
 * Role ladder: `guest` is a messaging membership of an inbox space
 * — above `none` (it is a member there), below `read` (it sees no documents). Guest → (new), Viewer →
 * read, Editor → write, Admin → admin; `propose` stays as it is.
 */
export const ROLES: readonly Role[] = ['none', 'guest', 'read', 'propose', 'write', 'admin'];

export function rank(role: Role): number {
  return ROLES.indexOf(role);
}

export function atLeast(role: Role, min: Role): boolean {
  return rank(role) >= rank(min);
}

export function maxRole(a: Role, b: Role): Role {
  return rank(a) >= rank(b) ? a : b;
}

export interface GrantLike {
  scope: 'space' | 'path' | 'doc';
  /** For scope = path: the prefix in path_key form, with a trailing `/`. */
  path_prefix: string | null;
  doc_id: string | null;
  subject_type: 'principal' | 'group';
  subject_id: string;
  role: Role;
}

export interface Subjects {
  principalId: string;
  /** All groups, including the computed all-agents group. */
  groupIds: readonly string[];
}

export interface Target {
  /** path_key of a document or folder (folders end with `/`); without it, the space level. */
  pathKey?: string | undefined;
  docId?: string | undefined;
}

export interface Flags {
  superadmin: boolean;
  disabled: boolean;
  archived: boolean;
}

/** `mail`: decided by the mail read predicate (core/guard `mailRule`). */
export type Level = 'disabled' | 'archived' | 'superadmin' | 'doc' | 'path' | 'space' | 'none' | 'mail';

export interface Resolution<G extends GrantLike = GrantLike> {
  role: Role;
  level: Level;
  /** Grants of the chosen level that apply to the subjects (personal ones first). */
  decisive: G[];
  /** A personal grant decided (step 6: a personal grant beats group grants at the same level). */
  personal: boolean;
}

function appliesToSubject(g: GrantLike, s: Subjects): boolean {
  return g.subject_type === 'principal' ? g.subject_id === s.principalId : s.groupIds.includes(g.subject_id);
}

function decide<G extends GrantLike>(level: Level, grants: G[]): Resolution<G> {
  const personal = grants.filter((g) => g.subject_type === 'principal');
  if (personal.length > 0) return { role: personal[0]!.role, level, decisive: personal, personal: true };
  let role: Role = 'none';
  for (const g of grants) role = maxRole(role, g.role);
  return { role, level, decisive: grants, personal: false };
}

export function resolveRole<G extends GrantLike>(spaceGrants: readonly G[], subjects: Subjects, target: Target, flags: Flags): Resolution<G> {
  // 1. Disabled, or the space is archived (except for superadmin).
  if (flags.disabled) return { role: 'none', level: 'disabled', decisive: [], personal: false };
  if (flags.archived && !flags.superadmin) return { role: 'none', level: 'archived', decisive: [], personal: false };
  // 2. superadmin is admin everywhere.
  if (flags.superadmin) return { role: 'admin', level: 'superadmin', decisive: [], personal: false };
  // 3–4. The subjects' grants that apply to the target.
  const mine = spaceGrants.filter((g) => appliesToSubject(g, subjects));
  // 5. The narrowest level wins: document → longest prefix → shorter → space.
  if (target.docId !== undefined) {
    const doc = mine.filter((g) => g.scope === 'doc' && g.doc_id === target.docId);
    if (doc.length > 0) return decide('doc', doc);
  }
  if (target.pathKey !== undefined) {
    const key = target.pathKey;
    const paths = mine.filter((g) => g.scope === 'path' && g.path_prefix !== null && key.startsWith(g.path_prefix));
    if (paths.length > 0) {
      const longest = Math.max(...paths.map((g) => g.path_prefix!.length));
      return decide('path', paths.filter((g) => g.path_prefix!.length === longest));
    }
  }
  const space = mine.filter((g) => g.scope === 'space');
  if (space.length > 0) return decide('space', space);
  // 7. No grants.
  return { role: 'none', level: 'none', decisive: [], personal: false };
}
