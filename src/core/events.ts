// Event bus (commit step 12): an extension point for webhooks, and later MCPL push.
// An event is published inside the write transaction; subscribers are synchronous and write only to
// the DB (the webhook queue). So the event and the write are atomic: rolling back the write also undoes
// the queue row, and a committed write does not lose its event if the process crashes. Network delivery
// is done by a separate loop (core/webhooks.ts) after commit.
import type { Kind, Trust } from '../store/types.js';

export interface EventAuthor {
  name: string;
  kind: Kind;
  trust: Trust;
}

export interface RevisionCreated {
  type: 'revision.created';
  seq: number;
  space_id: string;
  doc: { id: string; space: string; path: string };
  rev: number;
  kind: string;
  author: EventAuthor;
  attention: boolean;
  created_at: number;
}

export interface ProposalCreated {
  type: 'proposal.created';
  space_id: string;
  proposal: { id: string; space: string; path: string; doc_id: string | null; base_rev: number };
  author: EventAuthor;
  /** Executable space and the author is not admin: only a human can accept. */
  attention: boolean;
  created_at: number;
}

export type BrainEvent = RevisionCreated | ProposalCreated;
export type EventType = BrainEvent['type'];
export const EVENT_TYPES: readonly EventType[] = ['revision.created', 'proposal.created'];

export type Subscriber = (event: BrainEvent) => void;

export interface EventBus {
  subscribe(fn: Subscriber): () => void;
  /** Calls subscribers synchronously; a subscriber error rolls back the write transaction. */
  publish(event: BrainEvent): void;
  /** Called after a write with events is committed (wakes delivery). */
  afterCommit(fn: () => void): () => void;
  notifyCommitted(): void;
}

export function createEventBus(): EventBus {
  const subs = new Set<Subscriber>();
  const after = new Set<() => void>();
  return {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    publish(event) {
      for (const fn of subs) fn(event);
    },
    afterCommit(fn) {
      after.add(fn);
      return () => after.delete(fn);
    },
    notifyCommitted() {
      for (const fn of after) fn();
    },
  };
}
