// Webhooks: a bus subscriber puts a row into webhook_outbox for each matching webhook
// (space, event, attention_only); delivery is a POST with an HMAC-SHA256 signature of the body
// in the X-Brain-Signature header, retries with growing backoff up to 24 hours. The body carries
// no document content. Webhooks are created only by a caller with capability admin (execute via `requires`).
import { createHmac, randomBytes } from 'node:crypto';
import { getSpaceById } from '../store/spaces.js';
import {
  deleteWebhook,
  dueOutbox,
  enqueueOutbox,
  getWebhook,
  insertWebhook,
  listWebhooks,
  markAttemptFailed,
  markDelivered,
  outboxStats,
  updateWebhook,
  webhooksFor,
  type WebhookPatch,
  type WebhookRow,
} from '../store/webhooks.js';
import type { Core } from './context.js';
import { invalidInput, notFound } from './errors.js';
import { EVENT_TYPES, type BrainEvent, type EventType } from './events.js';
import type { AccessContext } from './guard.js';
import { newId } from './ids.js';
import { findSpace } from './spaces.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** First pause after a failure; then doubles up to MAX_BACKOFF. */
export const FIRST_BACKOFF = 30 * 1000;
export const MAX_BACKOFF = HOUR;
/** Retries stop one day after being queued. */
export const GIVE_UP_AFTER = 24 * HOUR;
const REQUEST_TIMEOUT = 10 * 1000;
const BATCH = 50;
const MAX_ERROR = 200;

export const SIGNATURE_HEADER = 'x-brain-signature';

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export function backoff(attempts: number): number {
  return Math.min(FIRST_BACKOFF * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF);
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Webhook body: no document content. */
export function payloadOf(e: BrainEvent): Record<string, unknown> {
  if (e.type === 'revision.created') {
    return { event: e.type, doc: e.doc, rev: e.rev, kind: e.kind, author: e.author, attention: e.attention, created_at: iso(e.created_at) };
  }
  return { event: e.type, proposal: e.proposal, author: e.author, attention: e.attention, created_at: iso(e.created_at) };
}

function parseEvents(row: WebhookRow): EventType[] {
  try {
    const v = JSON.parse(row.events) as unknown;
    return Array.isArray(v) ? (v.filter((x) => EVENT_TYPES.includes(x as EventType)) as EventType[]) : [];
  } catch {
    return [];
  }
}

/** Bus subscriber: queue rows in the same transaction as the write. */
export function enqueueForEvent(core: Core, e: BrainEvent): number {
  let n = 0;
  for (const hook of webhooksFor(core.db, e.type, e.space_id)) {
    if (hook.attention_only === 1 && !e.attention) continue;
    enqueueOutbox(core.db, hook.id, JSON.stringify(payloadOf(e)), core.now());
    n++;
  }
  return n;
}

// --- Delivery --------------------------------------------------------------------------------------

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number }>;

export interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

async function send(fetchImpl: FetchLike, hook: WebhookRow, body: string, deliveryId: string, event: string): Promise<SendResult> {
  try {
    const res = await fetchImpl(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'brain-webhooks/1',
        'x-brain-event': event,
        'x-brain-delivery': deliveryId,
        [SIGNATURE_HEADER]: signBody(hook.secret, body),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      // Redirects are not followed: the address is set by the administrator, not by the receiver.
      redirect: 'manual',
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { ok: false, status: null, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : `network error (${name})` };
  }
}

const running = new WeakSet<Core>();

/**
 * Delivers queue rows that are due. One pass at a time per process; returns
 * the number delivered.
 */
export async function deliverDue(core: Core, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<number> {
  if (running.has(core)) return 0;
  running.add(core);
  let delivered = 0;
  try {
    for (const row of dueOutbox(core.db, core.now(), BATCH)) {
      const hook = getWebhook(core.db, row.webhook_id);
      if (!hook || hook.enabled === 0) {
        markAttemptFailed(core.db, row.id, 'webhook disabled', row.next_attempt_at, core.now());
        continue;
      }
      const event = (JSON.parse(row.payload) as { event?: string }).event ?? 'unknown';
      const r = await send(fetchImpl, hook, row.payload, String(row.id), event);
      const now = core.now();
      if (r.ok) {
        markDelivered(core.db, row.id, now);
        delivered++;
        continue;
      }
      const attempts = row.attempts + 1;
      const giveUp = now - row.created_at >= GIVE_UP_AFTER;
      markAttemptFailed(core.db, row.id, (r.error ?? 'failed').slice(0, MAX_ERROR), now + backoff(attempts), giveUp ? now : null);
    }
  } catch (err) {
    core.log.error({ err }, 'webhook delivery failed');
  } finally {
    running.delete(core);
  }
  return delivered;
}

// --- Administration (admin_webhook_*) ---------------------------------------------------------------

export interface WebhookView {
  id: string;
  url: string;
  events: EventType[];
  space: string | null;
  attention_only: boolean;
  enabled: boolean;
  created_at: number;
  pending: number;
  failed: number;
  last_error: string | null;
  last_delivered_at: number | null;
}

export interface WebhookSettings {
  url?: string | undefined;
  events?: readonly EventType[] | undefined;
  space?: string | null | undefined;
  attentionOnly?: boolean | undefined;
  enabled?: boolean | undefined;
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/** URL: `https:` or a host from BRAIN_WEBHOOK_ALLOW_HOSTS (for a curator's local inbox). */
export function checkWebhookUrl(core: Core, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidInput('url', 'Not a URL.');
  }
  if (url.username || url.password) throw invalidInput('url', 'Credentials in the URL are not allowed.');
  const allowed = core.config.webhookAllowHosts.includes(url.hostname) || core.config.webhookAllowHosts.includes(url.host);
  if (url.protocol === 'https:' || ((url.protocol === 'http:' || url.protocol === 'https:') && allowed)) return url.toString();
  throw invalidInput('url', 'Webhook URL must use https:, or its host must be listed in BRAIN_WEBHOOK_ALLOW_HOSTS.');
}

function spaceIdOf(ctx: AccessContext, slug: string | null | undefined): string | null | undefined {
  if (slug === undefined || slug === null) return slug;
  const s = findSpace(ctx.core, slug);
  if (!s) throw notFound();
  return s.id;
}

function view(core: Core, row: WebhookRow): WebhookView {
  const space = row.space_id === null ? null : (getSpaceById(core.db, row.space_id)?.slug ?? null);
  return {
    id: row.id,
    url: row.url,
    events: parseEvents(row),
    space,
    attention_only: row.attention_only === 1,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    ...outboxStats(core.db, row.id),
  };
}

function requireHook(core: Core, id: string): WebhookRow {
  const row = getWebhook(core.db, id);
  if (!row) throw notFound();
  return row;
}

export function webhookCreate(ctx: AccessContext, s: WebhookSettings & { url: string }): { webhook: WebhookView; secret: string } {
  const core = ctx.core;
  const secret = newSecret();
  const row: WebhookRow = {
    id: newId(core.now()),
    url: checkWebhookUrl(core, s.url),
    secret,
    events: JSON.stringify(s.events && s.events.length ? [...new Set(s.events)] : ['revision.created']),
    space_id: spaceIdOf(ctx, s.space) ?? null,
    attention_only: s.attentionOnly ? 1 : 0,
    enabled: s.enabled === false ? 0 : 1,
    created_at: core.now(),
    created_by: ctx.principal.id,
  };
  insertWebhook(core.db, row);
  return { webhook: view(core, row), secret };
}

export function webhookUpdate(ctx: AccessContext, id: string, s: WebhookSettings & { rotateSecret?: boolean | undefined }): { webhook: WebhookView; secret?: string } {
  const core = ctx.core;
  requireHook(core, id);
  const patch: WebhookPatch = {};
  if (s.url !== undefined) patch.url = checkWebhookUrl(core, s.url);
  if (s.events !== undefined) {
    if (s.events.length === 0) throw invalidInput('events', 'At least one event is required.');
    patch.events = JSON.stringify([...new Set(s.events)]);
  }
  if (s.space !== undefined) patch.space_id = spaceIdOf(ctx, s.space) ?? null;
  if (s.attentionOnly !== undefined) patch.attention_only = s.attentionOnly ? 1 : 0;
  if (s.enabled !== undefined) patch.enabled = s.enabled ? 1 : 0;
  let secret: string | undefined;
  if (s.rotateSecret) patch.secret = secret = newSecret();
  updateWebhook(core.db, id, patch);
  return { webhook: view(core, requireHook(core, id)), ...(secret ? { secret } : {}) };
}

export function webhookDelete(ctx: AccessContext, id: string): void {
  requireHook(ctx.core, id);
  deleteWebhook(ctx.core.db, id);
}

export function webhookList(ctx: AccessContext): WebhookView[] {
  return listWebhooks(ctx.core.db).map((r) => view(ctx.core, r));
}

/** A test delivery right away, bypassing the queue: `{event: "webhook.test"}` with a signature. */
export async function webhookTest(ctx: AccessContext, id: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<SendResult> {
  const hook = requireHook(ctx.core, id);
  const body = JSON.stringify({ event: 'webhook.test', webhook_id: hook.id, created_at: iso(ctx.core.now()) });
  return send(fetchImpl, hook, body, `test-${newId(ctx.core.now())}`, 'webhook.test');
}
