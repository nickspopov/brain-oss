// Inbox threads. Pure helpers of the
// two-pane Inbox: messages grouped by thread, the tab a thread belongs to, what "Done" acknowledges
// (a snapshot of ids and revisions taken from what is on screen) and what opening a thread marks
// received (only messages to the viewer, only after they rendered).
import type { HandoffMessage } from '../api/types';

export type InboxTab = 'inbox' | 'sent' | 'done';

export const isWaiting = (m: HandoffMessage): boolean => m.status === 'new' || m.status === 'updated';
export const isOpen = (m: HandoffMessage): boolean => m.status !== 'done' && m.status !== 'declined';

export interface Thread {
  id: string;
  /** Oldest first. */
  messages: HandoffMessage[];
  /** The original message if present, else the oldest one. */
  root: HandoffMessage;
  latest: HandoffMessage;
  /** Subject without "Re: ". */
  subject: string;
  space: string;
  /** The viewer sent or received a message of the thread. */
  mine: boolean;
  /** The other party (the viewer's correspondent), or "a ↔ b" for a thread the viewer only oversees. */
  other: string;
  otherExternal: boolean;
  /** A message to the viewer not received at its current content. */
  unread: boolean;
  tab: InboxTab;
  /** Newest change in the thread (ISO). */
  changed_at: string;
}

const subjectOf = (title: string): string => title.replace(/^(Re:\s*)+/i, '');

/** Inbox: an open message to me; Sent: an open message from me (waiting on them); Done: the rest. */
export function tabOf(messages: readonly HandoffMessage[], me: string): InboxTab {
  if (messages.some((m) => m.to === me && isOpen(m))) return 'inbox';
  if (messages.some((m) => m.from === me && isOpen(m))) return 'sent';
  if (messages.some((m) => isOpen(m)) && !messages.some((m) => m.from === me || m.to === me)) return 'inbox';
  return 'done';
}

/** Threads newest change first; inside a thread oldest first. */
export function buildThreads(messages: readonly HandoffMessage[], me: string): Thread[] {
  const by = new Map<string, HandoffMessage[]>();
  for (const m of messages) {
    const list = by.get(m.thread_id);
    if (list) list.push(m);
    else by.set(m.thread_id, [m]);
  }
  const out: Thread[] = [];
  for (const [id, list] of by) {
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const root = sorted.find((m) => m.id === id) ?? sorted[0]!;
    const latest = sorted[sorted.length - 1]!;
    const mine = sorted.some((m) => m.from === me || m.to === me);
    const peer = sorted.find((m) => m.from !== me || m.to !== me) ?? root;
    const other = mine ? (peer.from === me ? peer.to : peer.from) : `${root.from} ↔ ${root.to}`;
    const otherExternal = mine ? (peer.from === me ? peer.to_external === true : peer.from_external === true) : root.from_external === true || root.to_external === true;
    const changed = sorted.reduce((t, m) => (m.changed_at > t ? m.changed_at : t), sorted[0]!.changed_at);
    out.push({
      id,
      messages: sorted,
      root,
      latest,
      subject: subjectOf(root.title),
      space: root.space,
      mine,
      other,
      otherExternal,
      unread: sorted.some((m) => m.to === me && isWaiting(m)),
      tab: tabOf(sorted, me),
      changed_at: changed,
    });
  }
  return out.sort((a, b) => b.changed_at.localeCompare(a.changed_at) || b.id.localeCompare(a.id));
}

export interface AckTarget {
  id: string;
  rev: number;
}

/**
 * What "Done" acknowledges: the open messages to me as they are on screen, by id and revision. A
 * reply that arrives later is not in the snapshot and stays pending; a message that changed since
 * fails its expected_rev on the server and stays open.
 */
export function doneSnapshot(thread: Thread, me: string): AckTarget[] {
  return thread.messages.filter((m) => m.to === me && isOpen(m)).map((m) => ({ id: m.id, rev: m.rev }));
}

/** Messages that opening the thread marks received: waiting messages to me (never someone else's). */
export function toMarkReceived(thread: Thread, me: string): AckTarget[] {
  return thread.messages.filter((m) => m.to === me && isWaiting(m)).map((m) => ({ id: m.id, rev: m.rev }));
}

/** The latest open message to me (Decline) / from me (Withdraw), if any. */
export const latestOpenTo = (thread: Thread, me: string): HandoffMessage | undefined => [...thread.messages].reverse().find((m) => m.to === me && isOpen(m));
export const latestOpenFrom = (thread: Thread, me: string): HandoffMessage | undefined => [...thread.messages].reverse().find((m) => m.from === me && isOpen(m));

/**
 * The recipient's state of one message, as its sender (or a space admin overseeing
 * it) sees it. Read from the envelope only (status, received_at, resolved_at, note); never acks.
 */
export type SenderState =
  | { kind: 'sent' }
  | { kind: 'seen'; at: string | null }
  | { kind: 'updated' }
  | { kind: 'done'; at: string | null; by: string | null; note: string | null }
  | { kind: 'declined'; at: string | null; by: string | null; note: string | null };

export function senderState(m: HandoffMessage): SenderState {
  switch (m.status) {
    case 'new':
      return { kind: 'sent' };
    case 'received':
      return { kind: 'seen', at: m.received_at };
    case 'updated':
      // Edited after the recipient received it: the new content is not seen yet.
      return { kind: 'updated' };
    case 'done':
    case 'declined':
      return { kind: m.status, at: m.resolved_at, by: m.resolved_by, note: m.note };
  }
}

/**
 * The message whose state the thread row shows: in my thread, my latest open message, else the
 * latest message if it is mine (nothing when the other party spoke last and nothing of mine is
 * open); in a thread I only oversee, the latest open message, else the latest.
 */
export function statusMessage(thread: Thread, me: string): HandoffMessage | undefined {
  if (!thread.mine) return [...thread.messages].reverse().find(isOpen) ?? thread.latest;
  return latestOpenFrom(thread, me) ?? (thread.latest.from === me ? thread.latest : undefined);
}

/**
 * The Sent tab: conversations waiting on the other party (open messages from me) first, then the
 * finished ones whose last word was mine (done / declined; they stay in Done too). Newest change
 * first inside each group.
 */
export function sentThreads(threads: readonly Thread[], me: string): Thread[] {
  const open = threads.filter((th) => th.tab === 'sent');
  const finished = threads.filter((th) => th.mine && th.tab === 'done' && th.latest.from === me);
  return [...open, ...finished];
}

/** Reply depth inside a thread (0 for the original), for indentation. */
export function depthOf(m: HandoffMessage, byId: ReadonlyMap<string, HandoffMessage>): number {
  let d = 0;
  let cur: HandoffMessage | undefined = m;
  while (cur?.reply_to && d < 8) {
    d++;
    cur = byId.get(cur.reply_to);
  }
  return d;
}

/** Replies under the message they answer (depth-first, oldest first among siblings). */
export function conversationOrder(thread: Thread): { m: HandoffMessage; depth: number }[] {
  const byId = new Map(thread.messages.map((m) => [m.id, m]));
  const children = new Map<string, HandoffMessage[]>();
  const roots: HandoffMessage[] = [];
  for (const m of thread.messages) {
    if (m.reply_to && byId.has(m.reply_to)) {
      const list = children.get(m.reply_to);
      if (list) list.push(m);
      else children.set(m.reply_to, [m]);
    } else roots.push(m);
  }
  const out: { m: HandoffMessage; depth: number }[] = [];
  const walk = (m: HandoffMessage, depth: number) => {
    out.push({ m, depth });
    for (const c of children.get(m.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, depthOf(r, byId));
  return out;
}

/** Message body without its `# title` heading (the subject is shown above). */
export const bodyOf = (content: string | undefined): string => (content ?? '').replace(/^\uFEFF?#[^\n]*\n+/, '');
