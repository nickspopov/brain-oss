// Connect agent: one step creates the agent, its
// space memberships and a token — in one transaction — and the admin then watches for the agent's first
// authenticated contact. "Connected" is not an isolation test: the read model below also lists the spaces
// the agent does NOT see, each with a canary document the ops layer tries to read *as the agent*.
// The token is returned once by the operation and never stored here (only its hash, as for every token).
import type { PrincipalRow, Role, SpaceRow, Trust } from '../store/types.js';
import { getTokenById } from '../store/tokens.js';
import {
  adminConnectTarget,
  adminGrantSet,
  adminPrincipalCreate,
  adminTokenIssue,
  type ConnectTarget,
  type PrincipalView,
  type TokenView,
} from './admin.js';
import type { Core } from './context.js';
import { invalidInput, notFound } from './errors.js';
import type { AccessContext } from './guard.js';
import { principalAccess, type MemberAccess } from './members.js';
import { findPrincipal } from './principals.js';
import { findSpace } from './spaces.js';

export interface ConnectSpace {
  space: string;
  /** Engine role of the space-level grant (guest · read · propose · write · admin). */
  role: Exclude<Role, 'none'>;
}

export interface AgentConnectInput {
  name: string;
  display_name?: string | undefined;
  /** The managing person in Brain (a human), or… */
  owner?: string | undefined;
  /** …the name of someone outside Brain: the agent becomes External. */
  outside?: string | undefined;
  harness: string;
  trust?: Trust | undefined;
  spaces: readonly ConnectSpace[];
  days?: number | null | undefined;
}

export interface AgentConnectResult {
  principal: PrincipalView;
  token: string;
  token_view: TokenView;
  target: ConnectTarget;
}

/**
 * Principal + explicit space grants + token, atomically: if any step is refused (an unknown or archived
 * space, Guest where a space has no messages, an external created by an agent…), nothing remains.
 * No automatic General, never the all-agents group: membership is what is listed.
 */
export function agentConnect(ctx: AccessContext, i: AgentConnectInput): AgentConnectResult {
  const seen = new Set<string>();
  for (const s of i.spaces) {
    const key = s.space.toLowerCase();
    if (seen.has(key)) throw invalidInput('spaces', `${s.space} is listed twice.`);
    seen.add(key);
  }
  const external = i.outside !== undefined;
  if (external && i.owner !== undefined) throw invalidInput('owner', 'Pick a manager in Brain or name someone outside Brain, not both.');
  if (i.owner !== undefined) {
    const owner = findPrincipal(ctx.core, i.owner);
    if (!owner || owner.kind !== 'human' || owner.disabled_at !== null) throw invalidInput('owner', 'The manager is an active person in Brain.');
  }
  return ctx.core.db
    .transaction((): AgentConnectResult => {
      const principal = adminPrincipalCreate(ctx, {
        name: i.name,
        kind: 'agent',
        trust: i.trust ?? (external ? 'limited' : 'trusted'),
        display_name: i.display_name,
        owner: i.owner,
        harness: i.harness,
        ...(external ? { external: true, owner_label: i.outside } : {}),
      });
      for (const s of i.spaces) {
        const space = findSpace(ctx.core, s.space);
        if (!space) throw notFound();
        if (space.archived_at !== null) throw invalidInput('spaces', `${s.space} is archived.`);
        adminGrantSet(ctx, { space: space.slug, scope: 'space', subject: { type: 'principal', name: principal.name } }, s.role);
      }
      const t = adminTokenIssue(ctx, principal.name, { label: `Connect agent (${i.harness})`, days: i.days });
      return { principal, token: t.token, token_view: t.view, target: adminConnectTarget(ctx, principal.name) };
    })
    .immediate();
}

export interface SeenSpace {
  space: SpaceRow;
  access: MemberAccess;
}

export interface HiddenSpace {
  space: SpaceRow;
  /** A live document of that space (not a message) to try to read as the agent; null when the space is empty. */
  canary: { id: string; path: string } | null;
}

export interface ConnectionFacts {
  principal: PrincipalRow;
  token: { id: string; prefix: string; last_used_at: number | null; revoked_at: number | null; expires_at: number | null };
  connected: boolean;
  sees: SeenSpace[];
  hidden: HiddenSpace[];
}

/**
 * Connection state of one token of one agent. `connected` comes from authenticated contact only: the token's
 * last use is written by `authenticateToken` on a request that passed token checks — never by issuing,
 * downloading the bundle or reading this. Archived spaces are left out of both lists.
 */
export function connectionFacts(core: Core, name: string, tokenId: string): ConnectionFacts {
  const { principal, spaces } = principalAccess(core, name);
  const row = getTokenById(core.db, tokenId);
  if (!row || row.principal_id !== principal.id) throw notFound();
  const now = core.now();
  const usable = row.revoked_at === null && (row.expires_at === null || row.expires_at > now) && principal.disabled_at === null;
  const active = spaces.filter((s) => s.space.archived_at === null);
  const sees = active.filter((s) => s.access.member || s.access.visible);
  const hidden = active
    .filter((s) => !s.access.member && !s.access.visible)
    .map((s) => ({ space: s.space, canary: canaryDoc(core, s.space.id) }));
  return {
    principal,
    token: { id: row.id, prefix: row.prefix, last_used_at: row.last_used_at, revoked_at: row.revoked_at, expires_at: row.expires_at },
    connected: usable && row.last_used_at !== null,
    sees,
    hidden,
  };
}

/** The most recently changed live document of a space that is not a message. */
function canaryDoc(core: Core, spaceId: string): { id: string; path: string } | null {
  const r = core.db
    .prepare(
      `SELECT id, path FROM documents
        WHERE space_id = ? AND deleted_at IS NULL AND id NOT IN (SELECT doc_id FROM handoff_messages)
        ORDER BY updated_at DESC, num DESC LIMIT 1`,
    )
    .get(spaceId) as { id: string; path: string } | undefined;
  return r ?? null;
}
