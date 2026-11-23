-- Handoff messages. A message is an ordinary document plus one envelope row; its status
-- (new, updated, received, done, declined) is derived from the row and the document, never stored.
CREATE TABLE handoff_messages (
  doc_id        TEXT PRIMARY KEY REFERENCES documents(id),
  tenant_id     TEXT NOT NULL,
  sender_id     TEXT NOT NULL REFERENCES principals(id),
  recipient_id  TEXT NOT NULL REFERENCES principals(id),
  thread_id     TEXT NOT NULL,
  reply_to      TEXT,
  created_at    INTEGER NOT NULL,
  -- last revision that changed the body; a change after receipt or resolution reopens the message
  content_rev   INTEGER NOT NULL,
  changed_at    INTEGER NOT NULL,
  received_rev  INTEGER,
  received_at   INTEGER,
  resolution    TEXT CHECK (resolution IN ('done', 'declined')),
  resolved_rev  INTEGER,
  resolved_at   INTEGER,
  resolved_by   TEXT REFERENCES principals(id),
  note          TEXT
);
CREATE INDEX handoff_messages_recipient ON handoff_messages (recipient_id, changed_at);
CREATE INDEX handoff_messages_sender ON handoff_messages (sender_id, created_at);
CREATE INDEX handoff_messages_thread ON handoff_messages (thread_id);

-- Time of the principal's last handoff_inbox(box="out"): answers after it give the sender a hint.
ALTER TABLE principals ADD COLUMN outbox_seen_at INTEGER;

-- Existing documents under handoff/<principal name>/ become messages, not received; sender = author of rev 1.
INSERT INTO handoff_messages (doc_id, tenant_id, sender_id, recipient_id, thread_id, reply_to, created_at, content_rev, changed_at)
SELECT d.id, d.tenant_id, r.author_id, p.id, d.id, NULL, d.created_at,
       COALESCE((SELECT max(b.rev) FROM revisions b WHERE b.doc_id = d.id AND b.kind IN ('create', 'update', 'revert', 'undo', 'import')), d.head_rev),
       d.updated_at
FROM documents d
JOIN spaces s ON s.id = d.space_id AND s.slug = 'handoff'
JOIN revisions r ON r.doc_id = d.id AND r.rev = 1
JOIN principals p ON p.tenant_id = d.tenant_id AND p.kind != 'system' AND p.disabled_at IS NULL
  AND lower(p.name) = substr(d.path_key, 1, instr(d.path_key, '/') - 1)
WHERE d.deleted_at IS NULL AND instr(d.path_key, '/') > 1 AND substr(d.path_key, 1, 8) != '_agents/';

-- Pending messages do not expire.
UPDATE documents SET expires_at = NULL WHERE id IN (SELECT doc_id FROM handoff_messages);
