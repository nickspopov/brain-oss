// Write routing: a write or a proposal.
// A role below propose is cut off by guard (not_found / forbidden) before this step.
import type { Role, SpaceRow, Trust } from '../store/types.js';
import { atLeast } from './access/resolve.js';
import { OpError } from './errors.js';
import { parseProtectedPaths } from './spaces.js';
import { pathKey } from './paths.js';

export type Route = 'commit' | 'propose';

export function isProtectedPath(space: SpaceRow, path: string): boolean {
  const key = pathKey(path);
  return parseProtectedPaths(space).some((p) => pathKey(p) === key);
}

/** The routing table, in order. */
export function routeWrite(space: SpaceRow, path: string, role: Role, trust: Trust): Route {
  const admin = atLeast(role, 'admin');
  if (isProtectedPath(space, path) && !admin) return 'propose';
  if (role === 'propose') return 'propose';
  if (space.review_mode === 'all' && !admin) return 'propose';
  if (space.review_mode === 'limited' && trust === 'limited' && !admin) return 'propose';
  return 'commit';
}

/** Refusal for a write that would become a proposal. */
export function reviewRequired(): OpError {
  return new OpError('forbidden', { required_role: 'admin', reason: 'review_required' });
}

/**
 * A write that requires review, for operations without proposals: `delete`, `move`, `restore`.
 * `write`, `edit`, `revert` in this situation create a proposal (core/documents, proposeInTx).
 */
export function requireDirectWrite(space: SpaceRow, path: string, role: Role, trust: Trust): void {
  if (routeWrite(space, path, role, trust) === 'propose') throw reviewRequired();
}

/** A revision needs a curator's attention: executable space and the author is not admin. */
export function needsAttention(space: SpaceRow, trust: Trust): boolean {
  return space.executable === 1 && trust !== 'admin';
}
