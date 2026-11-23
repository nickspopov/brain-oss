// Agent orientation: the owner-edited guide and per-token orientation state in memory.
// MCP over HTTP is stateless, so "this session" is approximated by a short sliding TTL per token.
import { getTenantGuide, setTenantGuide } from '../store/tenants.js';
import type { Core } from './context.js';
import { invalidInput } from './errors.js';

export const GUIDE_MAX = 1500;

export const DEFAULT_GUIDE =
  'Brain is a shared document memory for people and agents: markdown documents and files in spaces, with ' +
  'history and search. Every write is a new revision, so nothing is lost. Use it to keep notes, hand work ' +
  'over to other agents and find what others already know.';

/** Guide text for start_here: the owner's text or the default, never longer than GUIDE_MAX. */
export function guideText(core: Core): string {
  const own = getTenantGuide(core.db, core.tenantId);
  return (own ?? DEFAULT_GUIDE).slice(0, GUIDE_MAX);
}

export function guideIsDefault(core: Core): boolean {
  return getTenantGuide(core.db, core.tenantId) === null;
}

/** Sets the guide; null or blank text restores the default. */
export function setGuideText(core: Core, text: string | null): void {
  const t = text === null ? '' : text.trim();
  if (t.length > GUIDE_MAX) throw invalidInput('guide_text', `At most ${GUIDE_MAX} characters.`);
  setTenantGuide(core.db, core.tenantId, t === '' ? null : t);
}

/** Orientation state of one token (or MCP session). */
export interface OrientState {
  /** start_here was called within the TTL. */
  oriented: boolean;
  /** The "not oriented yet" note was already shown. */
  gateShown: boolean;
  /** Space ids whose AGENTS.md this session has read. */
  agentsRead: Set<string>;
  /** Space ids for which the "read AGENTS.md" note was already shown. */
  agentsHinted: Set<string>;
  expiresAt: number;
}

export interface OrientTracker {
  /** State for the key, created or refreshed (sliding TTL). */
  touch(key: string): OrientState;
  /** State for the key if it exists and has not expired; does not create or refresh. */
  peek(key: string): OrientState | undefined;
}

export const ORIENT_TTL_MS = 30 * 60 * 1000;
const MAX_KEYS = 10_000;

export function createOrientTracker(now: () => number, ttlMs = ORIENT_TTL_MS): OrientTracker {
  const map = new Map<string, OrientState>();
  const live = (key: string): OrientState | undefined => {
    const s = map.get(key);
    if (s && s.expiresAt <= now()) {
      map.delete(key);
      return undefined;
    }
    return s;
  };
  return {
    peek: live,
    touch(key) {
      let s = live(key);
      if (s) {
        map.delete(key);
      } else {
        s = { oriented: false, gateShown: false, agentsRead: new Set(), agentsHinted: new Set(), expiresAt: 0 };
        // Oldest first in insertion order: drop it when the map is full.
        if (map.size >= MAX_KEYS) {
          const first = map.keys().next();
          if (!first.done) map.delete(first.value);
        }
      }
      s.expiresAt = now() + ttlMs;
      map.set(key, s);
      return s;
    },
  };
}
