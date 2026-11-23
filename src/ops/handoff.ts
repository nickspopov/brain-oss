// Handoff notes after a call. Never block the call.
// - Address check: write/move creating a document under a folder that is not an agent name.
// - Message notes: a plain write that became a message; an edit that reopens a received message.
// - Hints: while the caller has messages not received at their current content (and answers they
//   have not seen), every other result carries one line (MCP) or a `handoff` field (REST).
import { answeredFor, getMessage, hintTitle, inboxHintLine, outboxHintLine, recipientCheck, visibleMessage, waitingFor } from '../core/inbox.js';
import type { AnyOp, OpContext } from './define.js';
import { adapterOf } from './registry.js';

interface Committed {
  status?: unknown;
  unchanged?: unknown;
  doc?: { id?: unknown; space?: unknown; path?: unknown; rev?: unknown };
}

const BODY_OPS = new Set(['write', 'edit', 'revert']);

export const registeredNote = (to: string, id: string): string => `Registered as a message to ${to} (id ${id}). Next time use handoff_send.`;
export const reopenNote = (to: string, rev: number): string =>
  `Note: ${to} already received rev ${rev}; this reopens it. For a new request use handoff_send with reply_to.`;

export function handoffNotes(ctx: OpContext, op: AnyOp, input: unknown, result: unknown): string[] {
  if (op.name !== 'write' && op.name !== 'move' && !BODY_OPS.has(op.name)) return [];
  const r = (result ?? {}) as Committed;
  const d = r.doc;
  if (!d || typeof d.space !== 'string' || typeof d.path !== 'string' || r.unchanged || r.status === 'proposed') return [];
  const notes: string[] = [];
  const created = op.name === 'write' && d.rev === 1;
  if (created || (op.name === 'move' && (input as { to_path?: unknown }).to_path !== undefined)) {
    const space = ctx.snapshot.spaceBySlug.get(d.space);
    const note = space ? recipientCheck(ctx.core, space, d.path) : undefined;
    if (note !== undefined) notes.push(note);
  }
  if (typeof d.id === 'string' && BODY_OPS.has(op.name)) {
    const m = getMessage(ctx.core.db, d.id);
    if (m && created) {
      const v = visibleMessage(ctx, d.id);
      if (v) notes.push(registeredNote(v.recipient_name, d.id));
    } else if (m && m.content_rev === d.rev && m.received_rev !== null && m.received_rev < m.content_rev) {
      const v = visibleMessage(ctx, d.id);
      if (v) notes.push(reopenNote(v.recipient_name, m.received_rev));
    }
  }
  return notes;
}

/** Operations without the inbox hint: the handoff tools themselves and start_here (it embeds the inbox). */
function quiet(op: AnyOp): boolean {
  return op.name.startsWith('handoff_') || op.name === 'start_here';
}

/** Hint lines for an MCP result. */
export function inboxNotes(ctx: OpContext, op: AnyOp): string[] {
  const a = adapterOf(ctx.caller.via);
  if ((a !== 'mcp' && a !== 'mcpl') || quiet(op)) return [];
  return [inboxHintLine(waitingFor(ctx)), outboxHintLine(answeredFor(ctx))].filter((l): l is string => l !== undefined);
}

export interface HandoffSummary {
  /** Messages to the caller not received at their current content. */
  inbox_waiting: number;
  /** `title` is null for mail from an external principal. */
  newest?: { id: string; space: string; title: string | null; from: string; external?: true };
  /** The caller's messages answered since their last handoff_inbox(box="out"). */
  outbox_answered: number;
}

/** The same state as a field of REST responses; undefined when there is nothing. */
export function handoffSummary(ctx: OpContext, op: AnyOp): HandoffSummary | undefined {
  const a = adapterOf(ctx.caller.via);
  if (a !== 'rest' || quiet(op)) return undefined;
  const waiting = waitingFor(ctx);
  const answered = answeredFor(ctx).length;
  if (waiting.length === 0 && answered === 0) return undefined;
  const n = waiting[0];
  return {
    inbox_waiting: waiting.length,
    ...(n ? { newest: { id: n.doc_id, space: n.space_slug, title: hintTitle(n), from: n.sender_name, ...(n.sender_external === 1 ? { external: true as const } : {}) } } : {}),
    outbox_answered: answered,
  };
}
