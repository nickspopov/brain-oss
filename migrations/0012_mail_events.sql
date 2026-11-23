-- A durable history of message changes that
-- concern one principal, for client-held cursors on GET /api/v1/inbox?since= and handoff_wait(since).
-- One row per event: `inbound` (a message to the principal was created), `updated` (its body changed),
-- `answered` (a message the principal sent was done/declined). Rows are written in the same transaction
-- as the change; reading them never changes anything. Every read is filtered through current access.
CREATE TABLE mail_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  rev          INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('inbound', 'updated', 'answered')),
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX mail_events_principal ON mail_events (principal_id, seq);
CREATE INDEX mail_events_doc ON mail_events (doc_id);
CREATE INDEX mail_events_created ON mail_events (created_at);

-- Events with seq <= floor were pruned: a cursor below it must resynchronise.
CREATE TABLE mail_events_floor (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  seq  INTEGER NOT NULL
) STRICT;
INSERT INTO mail_events_floor (id, seq) VALUES (1, 0);
