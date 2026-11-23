// handoff_wait: a bounded wait
// for mail with the clock on the server. Stateless for the client: the deadline travels in `until`,
// every result names the exact next call.
import { z } from 'zod';
import { invalidInput } from '../../core/errors.js';
import { hintTitle, type MessageListRow } from '../../core/inbox.js';
import { CURSOR_MAX, EVENTS_FILTERS, headCursor, levelMatches, pollSince, type EventsFilter, type MailEventsPage } from '../../core/mailevents.js';
import { forgetWatch, mailState, rememberWatch, repeatedMail, waitForEvents, waitForMail, watchMinutes, type MailState } from '../../core/watch.js';
import { contextFor, type AccessContext } from '../../core/guard.js';
import { defineOp } from '../define.js';

export const HANDOFF_WAIT_DESCRIPTION = [
  'Wait for mail. Blocks up to 50 seconds and returns the moment a message arrives for you or one you sent is answered.',
  'Asked to "watch / monitor / keep an eye on your inbox for N minutes"? Call `handoff_wait(minutes=N)` once. Every result tells you the exact next call. Make that call and nothing else until the result says the watch is over. Do not sleep between calls and do not call `handoff_inbox` in a loop — this tool does the waiting.',
  'If you can run shell commands, use one command instead: `inbox-poll.sh --wait <seconds>` (no turns spent while waiting; get it from `<Brain URL>/inbox-poll.sh`).',
  "If you run on a schedule (cron, heartbeat), don't watch: put `inbox-poll.sh` in front of your wake-up.",
  'minutes: 1–120, first call only. until: copy from the previous result.',
].join('\n');

export const MAX_WATCH_MINUTES = 120;
const MINUTE = 60_000;
/** Slack for clocks and copying: an `until` this far beyond 120 minutes is still accepted. */
const UNTIL_SLACK_MS = 2 * MINUTE;

export const UNHANDLED_MAIL = "You have unhandled mail; waiting won't help. Read and ack it first.";

const Newest = z.object({
  id: z.string(),
  space: z.string(),
  /** Canonical space of the message. */
  canonical_space: z.string(),
  from: z.string(),
  /** null for mail from an external principal (its title is never echoed here). */
  title: z.string().nullable(),
  external: z.boolean(),
  /** For an answer: done or declined, and by whom. */
  resolution: z.enum(['done', 'declined']).optional(),
  by: z.string().optional(),
});

const WaitOutput = z.object({
  /** mail: a message waits for you; answered: one you sent was answered; no_mail: call again; over: the watch ended; unhandled: read and ack first. */
  status: z.enum(['mail', 'answered', 'no_mail', 'over', 'unhandled']),
  until: z.string(),
  minutes_left: z.number().int(),
  waiting: z.number().int(),
  answered: z.number().int(),
  newest: Newest.nullable(),
  /** The exact next call, or null when the watch is over. */
  next_call: z.string().nullable(),
  /** Length of the watch when known (this process started it). */
  watch_minutes: z.number().int().nullable(),
  /** Opaque position after this result; pass it as `since` to get only later events. */
  next_cursor: z.string(),
  /** With `since`: what changed after the cursor (or the level snapshot on resync). */
  events: z.array(z.object({ id: z.string(), rev: z.number().int(), kind: z.enum(['inbound', 'updated', 'answered']), space: z.string() })).optional(),
  /** More events after this page: call again with next_cursor. */
  more: z.literal(true).optional(),
  /** The cursor could not be used (expired, invalid, another principal's or filter's): events is the full current state. */
  resync: z.literal(true).optional(),
});
type WaitOut = z.output<typeof WaitOutput>;

const isoSec = (t: number): string => new Date(Math.floor(t / 1000) * 1000).toISOString().replace('.000Z', 'Z');

function newestOf(st: MailState, filter: EventsFilter): z.output<typeof Newest> | null {
  const w: MessageListRow | undefined = filter === 'answers' ? undefined : st.waiting[0];
  if (w) return { id: w.doc_id, space: w.space_slug, canonical_space: w.space_slug, from: w.sender_name, title: hintTitle(w), external: w.sender_external === 1 };
  const a = filter === 'inbox' ? undefined : st.answered[0];
  if (a) {
    return {
      id: a.doc_id,
      space: a.space_slug,
      canonical_space: a.space_slug,
      from: a.recipient_name,
      title: a.title,
      external: a.recipient_external === 1,
      resolution: a.resolution ?? 'done',
      by: a.resolver_name ?? a.recipient_name,
    };
  }
  return null;
}

/** Same mail = same message at the same content (or the same answer). */
function mailKey(st: MailState, filter: EventsFilter): string {
  const w = filter === 'answers' ? undefined : st.waiting[0];
  if (w) return `in:${w.doc_id}:${w.content_rev}`;
  const a = filter === 'inbox' ? undefined : st.answered[0];
  return a ? `out:${a.doc_id}:${a.resolved_at ?? 0}` : '';
}

export const handoffWaitOp = defineOp({
  name: 'handoff_wait',
  summary: 'Wait for mail (up to 50 s per call); for "watch your inbox for N minutes".',
  description: HANDOFF_WAIT_DESCRIPTION,
  input: z
    .object({
      minutes: z.number().int().min(1).max(MAX_WATCH_MINUTES).optional(),
      until: z.string().min(1).max(40).optional(),
      // An unusable cursor is answered with resync, never refused: only the length is bounded here.
      since: z.string().max(CURSOR_MAX * 4).optional().describe('Optional: next_cursor of an earlier result; then only events after it wake you.'),
      events: z.enum(EVENTS_FILTERS as [EventsFilter, ...EventsFilter[]]).optional().describe('Optional: inbox (mail to you), answers (your sent mail answered) or both (default).'),
    })
    .strict(),
  output: WaitOutput,
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: async (ctx, input): Promise<WaitOut> => {
    const core = ctx.core;
    const me = ctx.principal;
    const start = core.now();
    let until: number;
    if (input.until !== undefined) {
      until = Date.parse(input.until);
      if (!Number.isFinite(until) || !/^\d{4}-\d\d-\d\dT/.test(input.until)) throw invalidInput('until', 'Copy until from the previous result (ISO time).');
      if (until > start + MAX_WATCH_MINUTES * MINUTE + UNTIL_SLACK_MS) throw invalidInput('until', `At most ${MAX_WATCH_MINUTES} minutes ahead.`);
    } else if (input.minutes !== undefined) {
      until = Math.floor((start + input.minutes * MINUTE) / 1000) * 1000;
      rememberWatch(core, me.id, until, input.minutes);
    } else {
      until = Math.floor((start + core.config.limits.inboxWaitMaxMs) / 1000) * 1000;
    }
    const minutes = watchMinutes(core, me.id, until) ?? (input.minutes ?? null);
    const filter: EventsFilter = input.events ?? 'both';
    const since = input.since;
    interface Snap {
      st: MailState;
      cursor: string;
      page?: MailEventsPage;
    }
    // Level state and cursor from one synchronous read: a consistent snapshot.
    const snap = (c: AccessContext): Snap => {
      const st = mailState(c);
      if (since === undefined) return { st, cursor: headCursor(c, filter) };
      const page = pollSince(c, filter, since);
      return { st, cursor: page.next_cursor, page };
    };
    const result = (status: WaitOut['status'], sn: Snap): WaitOut => {
      const now = core.now();
      const left = Math.max(0, Math.ceil((until - now) / MINUTE));
      const over = until - now <= 0;
      if (status === 'over') forgetWatch(core, me.id);
      const more = [since !== undefined ? `since="${sn.cursor}"` : '', input.events !== undefined ? `events="${filter}"` : ''].filter(Boolean).join(', ');
      return {
        status,
        until: isoSec(until),
        minutes_left: left,
        waiting: sn.st.waiting.length,
        answered: sn.st.answered.length,
        newest: newestOf(sn.st, filter),
        next_call: status === 'over' || (over && status !== 'no_mail') ? null : `handoff_wait(until="${isoSec(until)}"${more ? `, ${more}` : ''})`,
        watch_minutes: minutes,
        next_cursor: sn.cursor,
        ...(sn.page ? { events: sn.page.events } : {}),
        ...(sn.page?.more ? { more: true as const } : {}),
        ...(sn.page?.resync ? { resync: true as const } : {}),
      };
    };
    const levelStatus = (st: MailState): 'mail' | 'answered' => (filter !== 'answers' && st.waiting.length > 0 ? 'mail' : 'answered');
    if (since !== undefined) {
      // Cursor mode: wake on events after the cursor; a resync always answers at once (fail towards waking).
      const eventStatus = (sn: Snap): WaitOut['status'] | undefined => {
        const ev = sn.page?.events ?? [];
        if (ev.some((e) => e.kind !== 'answered')) return 'mail';
        if (ev.length > 0) return 'answered';
        if (sn.page?.resync) return until - core.now() <= 0 ? 'over' : 'no_mail';
        return undefined;
      };
      let sn = snap(ctx);
      const first = eventStatus(sn);
      if (first) return result(first, sn);
      if (until - start <= 0) return result('over', sn);
      await waitForEvents(core, me, ctx.caller.tokenId, until - start, filter, since, ctx.caller.signal);
      sn = snap(contextFor(core, me));
      return result(eventStatus(sn) ?? (until - core.now() <= 0 ? 'over' : 'no_mail'), sn);
    }
    const first = snap(ctx);
    if (levelMatches(first.st.waiting.length, first.st.answered.length, filter)) {
      if (repeatedMail(core, me.id, mailKey(first.st, filter), start)) return result('unhandled', first);
      return result(levelStatus(first.st), first);
    }
    if (until - start <= 0) return result('over', first);
    const out = await waitForMail(core, me, ctx.caller.tokenId, until - start, ctx.caller.signal, filter);
    const sn = snap(contextFor(core, me));
    if (out.reason === 'mail' && levelMatches(sn.st.waiting.length, sn.st.answered.length, filter)) {
      repeatedMail(core, me.id, mailKey(sn.st, filter), core.now());
      return result(levelStatus(sn.st), sn);
    }
    // Timeout, superseded by a newer wait, client gone or shutdown: no mail.
    return result(until - core.now() <= 0 ? 'over' : 'no_mail', sn);
  },
  render: renderWait,
  isolation: {
    kind: 'inputs',
    // A deadline in the past answers at once (the walk must not park).
    build: () => ({ addressed: [], broad: [{ until: '2000-01-01T00:00:00Z' }] }),
  },
});

/** Result texts. */
export function renderWait(o: WaitOut): string {
  const text = renderLevel(o);
  if (o.events === undefined) return text;
  const tail = o.resync
    ? ' Your cursor could not be used (expired or not yours): this is the full current state; continue with the new cursor.'
    : o.events.length > 0
      ? ` ${o.events.length} event(s) since your cursor${o.more ? ', more after them' : ''}.`
      : '';
  return `${text}${tail}`;
}

function renderLevel(o: WaitOut): string {
  const keep = o.next_call !== null ? ` To keep watching (${o.minutes_left} min left): ${o.next_call}.` : ' The watch is over.';
  const n = o.newest;
  switch (o.status) {
    case 'no_mail':
      return `No mail. ${o.minutes_left} min left. Call ${o.next_call ?? `handoff_wait(until="${o.until}")`} now.`;
    case 'over':
      return `Watch over${o.watch_minutes !== null ? ` (${o.watch_minutes} min)` : ''}, no mail. Stop and report that nothing arrived.`;
    case 'unhandled':
      return UNHANDLED_MAIL;
    case 'mail': {
      if (!n) return `Mail: call handoff_inbox.${keep}`;
      const what = n.external || n.title === null ? `Mail from external agent ${n.from} (${n.space}).` : `Mail: ${JSON.stringify(n.title)} from ${n.from} (${n.space}).`;
      const more = o.waiting > 1 ? ` ${o.waiting} waiting in all: handoff_inbox lists them.` : '';
      return `${what} read("${n.id}"), then handoff_ack(received).${more}${keep}`;
    }
    case 'answered': {
      if (!n) return `Answered: call handoff_inbox(box="out").${keep}`;
      return `Answered: ${JSON.stringify(n.title)} ${n.resolution ?? 'done'} by ${n.by ?? n.from} (${n.space}). See handoff_inbox(box="out").${keep}`;
    }
  }
}
