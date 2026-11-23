// Inbox spaces: inboxes `<space>/<name>/`, agent cards `<space>/_agents/`
// without TTL, and a soft check that a new document is addressed to a valid recipient. A space is an
// inbox space by its `inbox` setting; `handoff` is only the default slug (and the default of handoff_send).
import type { Db } from '../db/open.js';
import type { SpaceRow } from '../store/types.js';
import { pathKey } from './paths.js';

export const HANDOFF_SPACE = 'handoff';
export const AGENTS_DIR = '_agents';

/** An inbox space: the `inbox` setting (true for `handoff` by migration and by default). */
export function isInboxSpace(space: Pick<SpaceRow, 'inbox'>): boolean {
  return space.inbox === 1;
}

/** Agent cards (`<inbox space>/_agents/…`) never expire. */
export function isAgentCard(space: Pick<SpaceRow, 'inbox'>, path: string): boolean {
  return isInboxSpace(space) && pathKey(path).startsWith(`${AGENTS_DIR}/`);
}

export function getLastStartHere(db: Db, principalId: string): number | null {
  const row = db.prepare('SELECT last_start_here_at AS t FROM principals WHERE id = ?').get(principalId) as { t: number | null } | undefined;
  return row?.t ?? null;
}

export function setLastStartHere(db: Db, principalId: string, at: number): void {
  db.prepare('UPDATE principals SET last_start_here_at = ? WHERE id = ?').run(at, principalId);
}

export const recipientNote = (folder: string, match: string | undefined): string =>
  `Note: '${folder}' is not an agent name; recipients find documents only under their exact name` +
  (match !== undefined ? ` (e.g. '${match}')` : '') +
  '.';

/** Closest name: one containing `wanted` or contained in it; the shortest length difference wins. */
export function closestName(names: readonly string[], wanted: string): string | undefined {
  const key = wanted.toLowerCase();
  if (key === '') return undefined;
  return names
    .filter((n) => n.toLowerCase().includes(key) || key.includes(n.toLowerCase()))
    .sort((a, b) => Math.abs(a.length - wanted.length) - Math.abs(b.length - wanted.length) || a.localeCompare(b))[0];
}
