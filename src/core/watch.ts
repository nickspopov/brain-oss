// Waiting for mail. The
// server carries the clock: one wait lasts at most BRAIN_INBOX_WAIT_MAX_S (50 s, under the 60 s MCP
// client default) and parks in core.waiters until the commit hook or an ack wakes it. The wake
// condition is the hint condition — mail not received at its current content, or an answer not seen
// in the outbox — so acknowledging is what re-arms a wait. Nothing here changes state.
import type { Core } from './context.js';
import { OpError } from './errors.js';
import { contextFor, type AccessContext } from './guard.js';
import { answeredFor, waitingFor, type MessageListRow } from './inbox.js';
import type { AuthenticatedPrincipal } from './tokens.js';
import { hasEventsSince, levelMatches, type EventsFilter } from './mailevents.js';
import type { WaitSlot, WakeReason } from './waiters.js';

export interface MailState {
  waiting: MessageListRow[];
  answered: MessageListRow[];
}

export function mailState(ctx: AccessContext): MailState {
  return { waiting: waitingFor(ctx), answered: answeredFor(ctx) };
}

export const hasMail = (s: MailState): boolean => s.waiting.length > 0 || s.answered.length > 0;

export interface WaitOutcome {
  reason: 'mail' | Exclude<WakeReason, 'event'>;
  state: MailState;
}

/**
 * Waits up to `ms` (capped) for mail of `principal`. Re-checks with a fresh access snapshot after
 * every wake, so a grant change or a revoked membership is honoured. `rate_limited` when the process
 * already parks the maximum number of waits; `unauthenticated` when the token or principal was revoked
 * while waiting.
 */
export async function waitForMail(
  core: Core,
  principal: AuthenticatedPrincipal,
  tokenId: string | undefined,
  ms: number,
  signal?: AbortSignal,
  filter: EventsFilter = 'both',
): Promise<WaitOutcome> {
  let state: MailState = { waiting: [], answered: [] };
  const reason = await parkUntil(core, principal, tokenId, ms, signal, 'level', (ctx) => {
    state = mailState(ctx);
    return levelMatches(state.waiting.length, state.answered.length, filter);
  });
  return { reason, state };
}

/**
 * Waits up to `ms` (capped) until a visible event after cursor `since` (or until the
 * cursor needs a resync). A cursor wait is one of several listeners: it parks in a cursor slot.
 */
export async function waitForEvents(
  core: Core,
  principal: AuthenticatedPrincipal,
  tokenId: string | undefined,
  ms: number,
  filter: EventsFilter,
  since: string,
  signal?: AbortSignal,
): Promise<WaitOutcome['reason']> {
  return parkUntil(core, principal, tokenId, ms, signal, 'cursor', (ctx) => hasEventsSince(ctx, filter, since));
}

async function parkUntil(
  core: Core,
  principal: AuthenticatedPrincipal,
  tokenId: string | undefined,
  ms: number,
  signal: AbortSignal | undefined,
  slot: WaitSlot,
  ready: (ctx: AccessContext) => boolean,
): Promise<WaitOutcome['reason']> {
  const deadline = performance.now() + Math.min(ms, core.config.limits.inboxWaitMaxMs);
  for (;;) {
    if (ready(contextFor(core, principal))) return 'mail';
    const left = deadline - performance.now();
    if (left <= 0) return 'timeout';
    const r = await core.waiters.park(principal.id, tokenId, left, signal, slot);
    if (r === 'event') continue;
    if (r === 'revoked') throw new OpError('unauthenticated');
    if (r === 'timeout') return ready(contextFor(core, principal)) ? 'mail' : 'timeout';
    return r;
  }
}

// --- handoff_wait bookkeeping ---------------------------------------------------------------------
// Stateless for the client (the deadline travels in `until`); the server keeps two small maps per
// principal, only for wording: the length of the watch ("Watch over (30 min)") and how often the same
// unhandled mail was returned (three times within 60 s → stop waiting, handle it).

const REPEAT_WINDOW_MS = 60_000;
export const REPEAT_LIMIT = 3;

interface WatchMemo {
  until: number;
  minutes: number;
}
interface RepeatMemo {
  key: string;
  count: number;
  first: number;
}

const memos = new WeakMap<Core, { watch: Map<string, WatchMemo>; repeat: Map<string, RepeatMemo> }>();

function memoOf(core: Core) {
  let m = memos.get(core);
  if (!m) {
    m = { watch: new Map(), repeat: new Map() };
    memos.set(core, m);
  }
  return m;
}

export function rememberWatch(core: Core, principalId: string, until: number, minutes: number): void {
  memoOf(core).watch.set(principalId, { until, minutes });
}

/** Minutes of the watch that ends at `until`, if this process started it. */
export function watchMinutes(core: Core, principalId: string, until: number): number | undefined {
  const w = memoOf(core).watch.get(principalId);
  return w && w.until === until ? w.minutes : undefined;
}

export function forgetWatch(core: Core, principalId: string): void {
  const m = memoOf(core);
  m.watch.delete(principalId);
  m.repeat.delete(principalId);
}

/**
 * Counts one more return of mail `key`; true when this is the REPEAT_LIMIT-th return of the same mail
 * within the window (the caller is looping instead of handling it).
 */
export function repeatedMail(core: Core, principalId: string, key: string, now: number): boolean {
  const m = memoOf(core).repeat;
  const r = m.get(principalId);
  if (!r || r.key !== key || now - r.first > REPEAT_WINDOW_MS) {
    m.set(principalId, { key, count: 1, first: now });
    return false;
  }
  r.count++;
  return r.count >= REPEAT_LIMIT;
}
