// admin_webhook_create | update | delete | list | test. The signing secret
// is shown once (on creation and on rotation) and is not saved for idempotency.
import { z } from 'zod';
import { EVENT_TYPES } from '../../core/events.js';
import { webhookCreate, webhookDelete, webhookList, webhookTest, webhookUpdate, type WebhookView } from '../../core/webhooks.js';
import { defineOp } from '../define.js';
import { IdSchema, SlugSchema, toIso } from '../types.js';
import { ADMIN, ADMIN_ISOLATION, RequestId } from './common.js';

const EventSchema = z.enum(EVENT_TYPES as unknown as [string, ...string[]]);
const UrlSchema = z.string().min(1).max(2048);

const WebhookViewSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  space: z.string().nullable(),
  attention_only: z.boolean(),
  enabled: z.boolean(),
  created_at: z.string(),
  pending: z.number().int(),
  failed: z.number().int(),
  last_error: z.string().nullable(),
  last_delivered_at: z.string().nullable(),
});

function webhookOut(w: WebhookView): z.input<typeof WebhookViewSchema> {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    space: w.space,
    attention_only: w.attention_only,
    enabled: w.enabled,
    created_at: toIso(w.created_at),
    pending: w.pending,
    failed: w.failed,
    last_error: w.last_error,
    last_delivered_at: w.last_delivered_at === null ? null : toIso(w.last_delivered_at),
  };
}

type EventName = (typeof EVENT_TYPES)[number];

export const adminWebhookCreateOp = defineOp({
  name: 'admin_webhook_create',
  summary: 'Create a webhook; the signing secret is returned once (admin).',
  description:
    'Creates a webhook that receives a POST for each event (default "revision.created"; also "proposal.created"). ' +
    'space limits it to one space; attention_only sends only events that need a curator (executable spaces, ' +
    'authors below admin trust). The body carries metadata, never document content, and is signed: header ' +
    'X-Brain-Signature = "sha256=" + hex HMAC-SHA256 of the body with the secret. The secret appears only in this ' +
    'response. Failed deliveries are retried with growing pauses for up to 24 hours. The URL must be https:, or its ' +
    'host must be in BRAIN_WEBHOOK_ALLOW_HOSTS. Repeating the same request_id answers conflict ' +
    '(webhook_already_created) instead of the secret.',
  input: z
    .object({
      url: UrlSchema,
      events: z.array(EventSchema).min(1).max(10).optional(),
      space: SlugSchema.optional(),
      attention_only: z.boolean().optional(),
      enabled: z.boolean().optional(),
      ...RequestId,
    })
    .strict(),
  output: z.object({ webhook: WebhookViewSchema, secret: z.string() }),
  ...ADMIN,
  idempotent: true,
  withholdReplay: 'webhook_already_created',
  handler: (ctx, i) => {
    const r = webhookCreate(ctx, {
      url: i.url,
      events: i.events as EventName[] | undefined,
      space: i.space,
      attentionOnly: i.attention_only,
      enabled: i.enabled,
    });
    return { webhook: webhookOut(r.webhook), secret: r.secret };
  },
  render: (o) => `Webhook ${o.webhook.id} → ${o.webhook.url}. Signing secret (shown once): ${o.secret}`,
  isolation: ADMIN_ISOLATION,
});

export const adminWebhookUpdateOp = defineOp({
  name: 'admin_webhook_update',
  summary: 'Change a webhook, or rotate its signing secret (admin).',
  description:
    'Updates url, events, space (null = all spaces), attention_only or enabled. rotate_secret: true issues a new ' +
    'signing secret, returned once in this response. Repeating the same request_id answers conflict ' +
    '(webhook_already_updated).',
  input: z
    .object({
      id: IdSchema,
      url: UrlSchema.optional(),
      events: z.array(EventSchema).min(1).max(10).optional(),
      space: SlugSchema.nullable().optional(),
      attention_only: z.boolean().optional(),
      enabled: z.boolean().optional(),
      rotate_secret: z.boolean().optional(),
      ...RequestId,
    })
    .strict(),
  output: z.object({ webhook: WebhookViewSchema, secret: z.string().optional() }),
  ...ADMIN,
  idempotent: true,
  withholdReplay: 'webhook_already_updated',
  handler: (ctx, i) => {
    const r = webhookUpdate(ctx, i.id, {
      url: i.url,
      events: i.events as EventName[] | undefined,
      space: i.space,
      attentionOnly: i.attention_only,
      enabled: i.enabled,
      rotateSecret: i.rotate_secret,
    });
    return { webhook: webhookOut(r.webhook), ...(r.secret ? { secret: r.secret } : {}) };
  },
  isolation: ADMIN_ISOLATION,
});

export const adminWebhookDeleteOp = defineOp({
  name: 'admin_webhook_delete',
  summary: 'Delete a webhook and its pending deliveries (admin).',
  description: 'Deletes a webhook; its queued deliveries are dropped.',
  input: z.object({ id: IdSchema, ...RequestId }).strict(),
  output: z.object({ deleted: z.literal(true) }),
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => {
    webhookDelete(ctx, i.id);
    return { deleted: true as const };
  },
  isolation: ADMIN_ISOLATION,
});

export const adminWebhookListOp = defineOp({
  name: 'admin_webhook_list',
  summary: 'List webhooks with delivery status (admin).',
  description: 'Lists webhooks (never their secrets) with the number of pending and abandoned deliveries and the last error.',
  input: z.object({}).strict(),
  output: z.object({ webhooks: z.array(WebhookViewSchema) }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx) => ({ webhooks: webhookList(ctx).map(webhookOut) }),
  isolation: ADMIN_ISOLATION,
});

export const adminWebhookTestOp = defineOp({
  name: 'admin_webhook_test',
  summary: 'Send a signed test event to a webhook now and report the result (admin).',
  description: 'Sends {"event":"webhook.test"} to the webhook right away (not through the queue) and returns whether it was accepted.',
  input: z.object({ id: IdSchema }).strict(),
  output: z.object({ delivered: z.boolean(), status: z.number().int().nullable(), error: z.string().nullable() }),
  ...ADMIN,
  idempotent: false,
  handler: async (ctx, i) => {
    const r = await webhookTest(ctx, i.id);
    return { delivered: r.ok, status: r.status, error: r.error };
  },
  isolation: ADMIN_ISOLATION,
});
