// Orientation nudges, never blocking: after a successful call over MCP, at most a soft
// gate ("not oriented yet") once per session, and "read <space>/AGENTS.md" once per space.
import { highestRole, rank, readableAgentsMd, visibleSpaces } from '../core/guard.js';
import { guestSpacesOf, inboxSpacesOf } from '../core/inbox.js';
import type { AnyOp, Caller, OpContext } from './define.js';
import { orientKey } from './agent/start_here.js';
import { adapterOf } from './registry.js';

export const NOT_ORIENTED_NOTE = 'Not oriented yet: call start_here once.';
export const agentsMdNote = (slug: string) => `Note: read ${slug}/AGENTS.md before working here.`;

const AGENTS_MD = 'agents.md';
/** Operations that touch a space (read, write, list, search hits); the rest get no AGENTS.md note. */
const SPACE_OPS = new Set(['read', 'write', 'edit', 'move', 'delete', 'restore', 'revert', 'list', 'search', 'propose', 'history', 'diff']);

interface DocLike {
  space?: unknown;
  path?: unknown;
}

function slugsTouched(op: AnyOp, input: unknown, result: unknown): { touched: string[]; agentsRead: string[] } {
  const touched = new Set<string>();
  const agentsRead = new Set<string>();
  const i = (input ?? {}) as { space?: unknown };
  const r = (result ?? {}) as { doc?: DocLike; results?: { doc?: DocLike }[]; spaces?: { slug?: unknown; agents_md?: unknown }[]; proposal?: DocLike };
  if (op.name === 'spaces') {
    // `spaces` carries AGENTS.md of every space the caller can read it in.
    for (const s of r.spaces ?? []) if (typeof s.slug === 'string' && s.agents_md) agentsRead.add(s.slug);
    return { touched: [], agentsRead: [...agentsRead] };
  }
  if (!SPACE_OPS.has(op.name)) return { touched: [], agentsRead: [] };
  if (typeof i.space === 'string') touched.add(i.space);
  const docs: DocLike[] = [r.doc, r.proposal, ...(r.results ?? []).map((h) => h.doc)].filter((d): d is DocLike => !!d);
  for (const d of docs) if (typeof d.space === 'string') touched.add(d.space);
  if (op.name === 'read' && r.doc && typeof r.doc.space === 'string' && typeof r.doc.path === 'string' && r.doc.path.toLowerCase() === AGENTS_MD) {
    agentsRead.add(r.doc.space);
  }
  return { touched: [...touched], agentsRead: [...agentsRead] };
}

/** Notes to append to an MCP tool result; updates the session state. */
export function orientNotes(ctx: OpContext, op: AnyOp, input: unknown, result: unknown): string[] {
  const a = adapterOf(ctx.caller.via);
  if (a !== 'mcp' && a !== 'mcpl') return [];
  if (op.name === 'start_here') return [];
  const key = orientKey(ctx);
  if (key === undefined) return [];
  const st = ctx.core.orient.touch(key);
  const notes: string[] = [];
  if (!st.oriented && !st.gateShown) {
    st.gateShown = true;
    notes.push(NOT_ORIENTED_NOTE);
  }
  const { touched, agentsRead } = slugsTouched(op, input, result);
  for (const slug of agentsRead) {
    const s = ctx.snapshot.spaceBySlug.get(slug);
    if (s) st.agentsRead.add(s.id);
  }
  for (const slug of touched) {
    const s = ctx.snapshot.spaceBySlug.get(slug);
    if (!s || st.agentsRead.has(s.id) || st.agentsHinted.has(s.id)) continue;
    // Only when the caller can read that AGENTS.md (otherwise the hint would reveal it).
    if (!readableAgentsMd(ctx, s)) continue;
    st.agentsHinted.add(s.id);
    notes.push(agentsMdNote(s.slug));
  }
  return notes;
}

/** What a message-only member (Guest, external) with no grant outside inbox spaces is offered. */
const EXTERNAL_SURFACE = new Set(['start_here', 'whoami', 'read', 'profile_get', 'profile_update']);
/** Operations on the caller's own record: offered to everyone (start_here asks each agent to fill its profile). */
const OWN_RECORD = new Set(['profile_get', 'profile_update']);

/**
 * Tool list hygiene: write operations are hidden from callers with no propose/write role anywhere;
  * handoff_* tools from callers who have no inbox space (they stay listed for members, read
 * only or not). An external principal without other grants sees only the handoff tools, read,
 * start_here and whoami.
 */
export function usableBy(ctx: OpContext, ops: AnyOp[]): AnyOp[] {
  const canWrite = rank(highestRole(ctx)) >= rank('propose');
  const handoff = inboxSpacesOf(ctx).length > 0;
  const onlyInbox = (ctx.principal.external === true || guestSpacesOf(ctx).length > 0) && visibleSpaces(ctx).length === 0;
  return ops.filter((op) => {
    if (op.name.startsWith('handoff_')) return handoff;
    if (onlyInbox && !EXTERNAL_SURFACE.has(op.name)) return false;
    return canWrite || op.effect !== 'write' || OWN_RECORD.has(op.name);
  });
}

export type { Caller };
