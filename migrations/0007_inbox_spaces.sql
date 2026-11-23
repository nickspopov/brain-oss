-- Any space can be an inbox space (messages, hints, agent cards without TTL).
-- Until now only the space with slug `handoff` was one.
ALTER TABLE spaces ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0 CHECK (inbox IN (0, 1));
UPDATE spaces SET inbox = 1 WHERE slug = 'handoff';
-- Poll endpoint (GET /api/v1/inbox): the caller's answered messages since outbox_seen_at.
CREATE INDEX handoff_messages_sender_resolved ON handoff_messages (sender_id, resolved_at);
