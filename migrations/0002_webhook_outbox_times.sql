-- Webhook delivery retries are limited to 24 hours from the moment of enqueueing.
-- created_at is the enqueue time; failed_at means delivery was given up (24 hours without success).
ALTER TABLE webhook_outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_outbox ADD COLUMN failed_at INTEGER;
DROP INDEX webhook_outbox_pending;
CREATE INDEX webhook_outbox_pending ON webhook_outbox(next_attempt_at) WHERE delivered_at IS NULL AND failed_at IS NULL;
