// handoff_send, handoff_inbox, handoff_ack: messages between agents and Alice, with
// explicit acknowledgement. Reading a message uses the ordinary `read`.
import { z } from 'zod';
import { forbidden } from '../../core/errors.js';
import {
  boxMessages,
  byStatus,
  countStatuses,
  getOutboxSeen,
  INBOX_PAGE,
  inboxSpaceIds,
  inSpace,
  MESSAGE_STATUSES,
  messageOut,
  setOutboxSeen,
  type MessageOut,
} from '../../core/inbox.js';
import { ackMessage, sendableRecipients, sendMessage } from '../../core/messages.js';
import { defineOp } from '../define.js';
import { DocInfoSchema, IdSchema, IsoTime, RequestIdSchema, SlugSchema } from '../types.js';
import { MISSING_ID, recheckDocReplay, RevNumber, writeCtx } from './common.js';
import { quoted } from './llmtext.js';

const StatusSchema = z.enum(MESSAGE_STATUSES as [MessageOut['status'], ...MessageOut['status'][]]);

export const HandoffMessageSchema = z.object({
  id: z.string(),
  space: z.string(),
  /** Canonical space (old inbox slugs are aliases of it). */
  canonical_space: z.string(),
  path: z.string(),
  title: z.string(),
  from: z.string(),
  to: z.string(),
  from_external: z.boolean(),
  to_external: z.boolean(),
  status: StatusSchema,
  rev: z.number().int(),
  content_rev: z.number().int(),
  thread_id: z.string(),
  reply_to: z.string().nullable(),
  created_at: IsoTime,
  changed_at: IsoTime,
  age: z.string(),
  received_rev: z.number().int().nullable(),
  received_at: IsoTime.nullable(),
  resolution: z.enum(['done', 'declined']).nullable(),
  resolved_at: IsoTime.nullable(),
  resolved_by: z.string().nullable(),
  note: z.string().nullable(),
  /** Start of the body, one line (the UI's thread list). */
  snippet: z.string(),
});
type Msg = z.output<typeof HandoffMessageSchema>;

const CountsSchema = z.object({ new: z.number().int(), updated: z.number().int(), received: z.number().int(), done: z.number().int(), declined: z.number().int() });

// --- handoff_send -------------------------------------------------------------------------------------

const SendOutput = z.object({
  message: HandoffMessageSchema,
  doc: DocInfoSchema,
  recipient_last_seen: IsoTime.nullable(),
  /** The recipient is an external principal (another person's agent). */
  recipient_external: z.object({ owner: z.string().nullable() }).optional(),
});

/** Added to the send result when the recipient is external. */
export const EXTERNAL_RECIPIENT_WARNING = 'Recipient is EXTERNAL: no secrets, no internal names or paths.';

export const handoffSendOp = defineOp({
  name: 'handoff_send',
  summary: 'Send a message to another agent or to alice; the recipient acks it.',
  description:
    'Sends a message to one recipient (an agent name, or alice for the owner). The server stores it at ' +
    '<space>/<to>/<date>-<title>.md with you as the sender; the recipient sees it on their next Brain call. ' +
    'space: a space with messages on; default handoff, or your only one, or the space of reply_to (an old inbox slug ' +
    'still works: it names its project space). ' +
    'Only you, the recipient and the admins of that space can read it. No secrets. For a follow-up or an answer, send a new message with reply_to=<message id>; ' +
    'do not edit a sent message for a new request. Track it with handoff_inbox(box="out"). ' +
    'Pass request_id to make retries safe.',
  input: z
    .object({
      to: z.string().min(1).max(63),
      title: z.string().min(1).max(200),
      body: z.string().max(256 * 1024),
      reply_to: IdSchema.optional(),
      space: SlugSchema.optional(),
      request_id: RequestIdSchema.optional(),
    })
    .strict(),
  output: SendOutput,
  effect: 'write',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, input) =>
    sendMessage(writeCtx(ctx, 'handoff_send', input.request_id), {
      to: input.to,
      title: input.title,
      body: input.body,
      replyTo: input.reply_to,
      space: input.space,
    }),
  replayCheck: recheckDocReplay,
  render: (o) => {
    const m = o.message;
    const seen = o.recipient_last_seen === null ? `${m.to} has not used Brain yet.` : `${m.to} was last in Brain at ${o.recipient_last_seen.slice(0, 16).replace('T', ' ')} UTC.`;
    return [
      `Sent to ${m.to}: ${quoted(m.title)} (id ${m.id}, rev ${m.rev}) at ${m.space}/${m.path}.`,
      `${seen} They see it on their next Brain call.`,
      `Track it: handoff_inbox(box="out"). Follow-up: handoff_send(to="${m.to}", reply_to="${m.id}", ...).`,
      ...(o.recipient_external ? [EXTERNAL_RECIPIENT_WARNING] : []),
    ].join('\n');
  },
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: [
        ...hidden.docIds.map((id) => ({
          input: { to: 'alice', title: 'isolation', body: 'x', reply_to: id },
          missing: { to: 'alice', title: 'isolation', body: 'x', reply_to: MISSING_ID },
        })),
        { input: { to: 'alice', title: 'isolation', body: 'x', space: hidden.space }, missing: { to: 'alice', title: 'isolation', body: 'x', space: 'no-such-space' } },
      ],
      broad: [],
    }),
  },
});

// --- handoff_recipients -------------------------------------------------------------------------------

const RecipientsOutput = z.object({
  recipients: z.array(
    z.object({
      name: z.string(),
      display_name: z.string(),
      external: z.boolean(),
      manager: z.string().nullable(),
      owner_label: z.string().nullable(),
      spaces: z.array(z.string()),
      /** The recipient's profile line. */
      what_i_do: z.string().nullable(),
    }),
  ),
});

/** The UI's To picker: only recipients handoff_send would accept, per inbox space. */
export const handoffRecipientsOp = defineOp({
  name: 'handoff_recipients',
  summary: 'Whom you can message: recipients handoff_send accepts, with the inbox spaces where it does.',
  description:
    'Lists enabled recipients in your own inbox spaces where you can send to them (never yourself). ' +
    'spaces: where a message to that recipient is accepted; pass one as handoff_send.space when there are several.',
  input: z.object({}).strict(),
  output: RecipientsOutput,
  effect: 'read',
  requires: 'any',
  expose: ['rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx) => ({ recipients: sendableRecipients(ctx) }),
  isolation: { kind: 'inputs', build: () => ({ addressed: [], broad: [{}] }) },
});

// --- handoff_inbox ------------------------------------------------------------------------------------

const InboxOutput = z.object({
  box: z.enum(['in', 'out', 'all']),
  principal: z.string(),
  counts: CountsSchema,
  messages: z.array(HandoffMessageSchema),
  /** More messages than returned (the newest INBOX_PAGE are shown). */
  more: z.boolean(),
  /** With `space`, the canonical space it names (an old inbox slug resolves to its project); null if unknown. */
  canonical_space: z.string().nullable().optional(),
});
type InboxOut = z.output<typeof InboxOutput>;

/** Description of the handoff_inbox tool. */
export const HANDOFF_INBOX_DESCRIPTION =
  'List messages; does not wait or acknowledge. To watch for a while use handoff_wait (no shell) or inbox-poll.sh (shell; get it from <Brain URL>/inbox-poll.sh). Never call this in a loop.';

export const handoffInboxOp = defineOp({
  name: 'handoff_inbox',
  summary: 'Your handoff messages: inbox (to you) or outbox (sent by you), with status.',
  description: HANDOFF_INBOX_DESCRIPTION,
  input: z
    .object({
      box: z
        .enum(['in', 'out', 'all'])
        .optional()
        .describe('"in" (default): messages to you; "out": sent by you (also shows answers you have not seen yet).'),
      include_done: z.boolean().optional().describe('Also list done and declined messages.'),
      space: SlugSchema.optional().describe('Only this inbox space (default: every inbox space you are in).'),
    })
    .strict()
    .describe('Status: new, updated (changed after you received it), received, done, declined. Read a message with read(id), then handoff_ack it.'),
  output: InboxOutput,
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) => {
    const box = input.box ?? 'in';
    // "all" is the owner's Handoff page: every message the caller can read.
    if (box === 'all' && ctx.principal.kind !== 'human') throw forbidden('human');
    const db = ctx.core.db;
    const seen = box === 'out' ? getOutboxSeen(db, ctx.principal.id) : undefined;
    // An unknown or hidden space is an empty list, like a space without messages.
    const named = input.space !== undefined ? ctx.snapshot.spaceBySlug.get(input.space) : undefined;
    const only = input.space !== undefined ? (named?.id ?? '') : undefined;
    const rows = byStatus(boxMessages(ctx, box, input.include_done ?? false, seen, only).map((r) => messageOut(ctx, r)));
    // The outbox "seen" time is one per principal: only a full outbox look moves it.
    if (box === 'out' && only === undefined) setOutboxSeen(db, ctx.principal.id, ctx.core.now());
    return {
      box,
      principal: ctx.principal.name,
      counts: countStatuses(rows),
      messages: rows.slice(0, INBOX_PAGE),
      more: rows.length > INBOX_PAGE,
      // Only a space the caller has mail access to is named (never reveals another space's slug).
      ...(input.space !== undefined ? { canonical_space: named && inboxSpaceIds(ctx, named.id).length > 0 ? named.slug : null } : {}),
    };
  },
  render: renderInbox,
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: [{ input: { space: hidden.space, include_done: true }, missing: { space: 'no-such-space', include_done: true } }],
      broad: [{}, { box: 'out' }, { include_done: true }, { box: 'out', include_done: true }],
    }),
  },
});

function countsText(c: InboxOut['counts']): string {
  const parts = (['new', 'updated', 'received', 'done', 'declined'] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`);
  return parts.length ? parts.join(', ') : 'empty';
}

export function messageLine(m: Msg, box: 'in' | 'out' | 'all'): string {
  const ext = (external: boolean) => (external ? ' (EXTERNAL)' : '');
  const who =
    box === 'in' ? `from ${m.from}${ext(m.from_external)}` : box === 'out' ? `to ${m.to}${ext(m.to_external)}` : `${m.from}${ext(m.from_external)} → ${m.to}${ext(m.to_external)}`;
  let state: string;
  switch (m.status) {
    case 'new':
      state = `sent ${m.age} ago, not received yet`;
      break;
    case 'updated':
      state = `changed ${m.age} ago (received rev ${m.received_rev}, now rev ${m.content_rev})`;
      break;
    case 'received':
      state = 'received, not done yet';
      break;
    default:
      state = `${m.status} by ${m.resolved_by ?? m.to}${m.note !== null ? `: ${quoted(m.note)}` : ''}`;
  }
  return `- ${m.status.toUpperCase()} ${quoted(m.title)} ${who}${inSpace(m.space)}, ${state} (id ${m.id}, rev ${m.rev})`;
}

export function renderInbox(o: InboxOut): string {
  const head = o.box === 'in' ? `Inbox for ${o.principal}` : o.box === 'out' ? `Outbox of ${o.principal}` : 'All messages';
  const lines = [`${head}: ${countsText(o.counts)}.`, ...o.messages.map((m) => messageLine(m, o.box))];
  if (o.more) lines.push(`Showing the newest ${o.messages.length}.`);
  if (o.box === 'in' && o.messages.some((m) => m.status !== 'done' && m.status !== 'declined')) {
    lines.push('Read: read(id). Then handoff_ack(id, expected_rev=<rev>, status="received"|"done"|"declined", note).');
  }
  if (o.box === 'in' && o.messages.length === 0) lines.push('Nothing to do. Send with handoff_send.');
  return lines.join('\n');
}

// --- handoff_ack ---------------------------------------------------------------------------------------

const AckOutput = z.object({ message: HandoffMessageSchema, already: z.boolean(), since: z.string().optional() });

export const handoffAckOp = defineOp({
  name: 'handoff_ack',
  summary: 'Acknowledge a message sent to you: received, done or declined.',
  description:
    'Acknowledges a message sent to you. status "received": you have seen it (stops reminders; it stays open). ' +
    '"done": handled. "declined": you will not do it (note required: why). expected_rev = the rev you read; if the ' +
    'message changed since, you get conflict: read it again. Only the recipient can ack. The sender sees the status ' +
    'and note in their outbox.',
  input: z
    .object({
      id: IdSchema,
      expected_rev: RevNumber,
      status: z.enum(['received', 'done', 'declined']),
      note: z.string().max(500).optional(),
      request_id: RequestIdSchema.optional(),
    })
    .strict(),
  output: AckOutput,
  effect: 'write',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, input) =>
    ackMessage(writeCtx(ctx, 'handoff_ack', input.request_id), { id: input.id, expectedRev: input.expected_rev, status: input.status, note: input.note }),
  replayCheck: (ctx, output) => recheckDocReplay(ctx, { doc: { id: (output as { message?: { id?: unknown } } | null)?.message?.id } }),
  render: (o) => {
    const m = o.message;
    if (o.already) return `Already ${m.status}${o.since !== undefined ? ` ${o.since}` : ''}: ${quoted(m.title)} (id ${m.id}, rev ${m.rev}).`;
    if (m.status === 'received') {
      return `Received ${quoted(m.title)} (rev ${m.rev}); reminders stop. When finished: handoff_ack(id="${m.id}", expected_rev=${m.rev}, status="done"|"declined", note).`;
    }
    return `Marked ${quoted(m.title)} as ${m.status}. ${m.from} sees it in their outbox.`;
  },
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: hidden.docIds.map((id) => ({
        input: { id, expected_rev: 1, status: 'received' },
        missing: { id: MISSING_ID, expected_rev: 1, status: 'received' },
      })),
      broad: [],
    }),
  },
});
