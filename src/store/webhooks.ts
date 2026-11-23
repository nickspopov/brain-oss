// Webhooks and the delivery queue: SQL only.
import type { Db } from '../db/open.js';

export interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events: string;
  space_id: string | null;
  attention_only: 0 | 1;
  enabled: 0 | 1;
  created_at: number;
  created_by: string | null;
}

export function insertWebhook(db: Db, row: WebhookRow): void {
  db.prepare(
    `INSERT INTO webhooks (id, url, secret, events, space_id, attention_only, enabled, created_at, created_by)
     VALUES (@id, @url, @secret, @events, @space_id, @attention_only, @enabled, @created_at, @created_by)`,
  ).run(row);
}

export function getWebhook(db: Db, id: string): WebhookRow | undefined {
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined;
}

export function listWebhooks(db: Db): WebhookRow[] {
  return db.prepare('SELECT * FROM webhooks ORDER BY created_at, id').all() as WebhookRow[];
}

export type WebhookPatch = Partial<Pick<WebhookRow, 'url' | 'secret' | 'events' | 'space_id' | 'attention_only' | 'enabled'>>;

export function updateWebhook(db: Db, id: string, patch: WebhookPatch): void {
  const keys = Object.keys(patch) as (keyof WebhookPatch)[];
  if (keys.length === 0) return;
  db.prepare(`UPDATE webhooks SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
}

export function deleteWebhook(db: Db, id: string): void {
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
}

/** Enabled webhooks subscribed to an event, for a space (or for all spaces). */
export function webhooksFor(db: Db, event: string, spaceId: string): WebhookRow[] {
  return db
    .prepare(
      `SELECT w.* FROM webhooks w
       WHERE w.enabled = 1 AND (w.space_id IS NULL OR w.space_id = ?)
         AND EXISTS (SELECT 1 FROM json_each(w.events) e WHERE e.value = ?)
       ORDER BY w.id`,
    )
    .all(spaceId, event) as WebhookRow[];
}

export interface OutboxRow {
  id: number;
  webhook_id: string;
  payload: string;
  attempts: number;
  next_attempt_at: number;
  delivered_at: number | null;
  last_error: string | null;
  created_at: number;
  failed_at: number | null;
}

export function enqueueOutbox(db: Db, webhookId: string, payload: string, now: number): number {
  return Number(
    db
      .prepare('INSERT INTO webhook_outbox (webhook_id, payload, attempts, next_attempt_at, created_at) VALUES (?, ?, 0, ?, ?)')
      .run(webhookId, payload, now, now).lastInsertRowid,
  );
}

export function dueOutbox(db: Db, now: number, limit: number): OutboxRow[] {
  return db
    .prepare(
      `SELECT * FROM webhook_outbox
       WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id LIMIT ?`,
    )
    .all(now, limit) as OutboxRow[];
}

export function getOutbox(db: Db, id: number): OutboxRow | undefined {
  return db.prepare('SELECT * FROM webhook_outbox WHERE id = ?').get(id) as OutboxRow | undefined;
}

export function markDelivered(db: Db, id: number, now: number): void {
  db.prepare('UPDATE webhook_outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?').run(now, id);
}

export function markAttemptFailed(db: Db, id: number, error: string, nextAttemptAt: number, failedAt: number | null): void {
  db.prepare('UPDATE webhook_outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, failed_at = ? WHERE id = ?').run(
    error,
    nextAttemptAt,
    failedAt,
    id,
  );
}

/** Queue summary per webhook (for admin_webhook_list). */
export function outboxStats(db: Db, webhookId: string): { pending: number; failed: number; last_error: string | null; last_delivered_at: number | null } {
  const row = db
    .prepare(
      `SELECT
         sum(CASE WHEN delivered_at IS NULL AND failed_at IS NULL THEN 1 ELSE 0 END) AS pending,
         sum(CASE WHEN failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed,
         max(delivered_at) AS last_delivered_at
       FROM webhook_outbox WHERE webhook_id = ?`,
    )
    .get(webhookId) as { pending: number | null; failed: number | null; last_delivered_at: number | null };
  const err = db
    .prepare('SELECT last_error FROM webhook_outbox WHERE webhook_id = ? AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(webhookId) as { last_error: string } | undefined;
  return { pending: row.pending ?? 0, failed: row.failed ?? 0, last_error: err?.last_error ?? null, last_delivered_at: row.last_delivered_at };
}

/** Deletes delivered and abandoned rows older than `before`. */
export function pruneOutbox(db: Db, before: number): number {
  return db
    .prepare('DELETE FROM webhook_outbox WHERE (delivered_at IS NOT NULL AND delivered_at < ?) OR (failed_at IS NOT NULL AND failed_at < ?)')
    .run(before, before).changes;
}

/** Undelivered rows about this document (document purge). */
export function deleteOutboxForDoc(db: Db, docId: string): void {
  db.prepare("DELETE FROM webhook_outbox WHERE delivered_at IS NULL AND json_extract(payload, '$.doc.id') = ?").run(docId);
}
