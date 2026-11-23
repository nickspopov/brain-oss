-- Brain: initial schema. Time is INTEGER, Unix ms UTC; ids are ULID TEXT.
-- Migrations are forward-only; applied by PRAGMA user_version inside a transaction (src/db/migrate.ts).

-- Internal process keys (search tokenizer version and the like).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Identity --------------------------------------------------------------------

CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE principals (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  name          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('superadmin', 'member')),
  trust         TEXT NOT NULL CHECK (trust IN ('admin', 'trusted', 'limited')),
  owner_id      TEXT REFERENCES principals(id),
  harness       TEXT,
  password_hash TEXT,
  start_seq     INTEGER NOT NULL DEFAULT 0,
  disabled_at   INTEGER,
  -- Capability `admin`: access to admin_* operations for any kind.
  can_admin     INTEGER NOT NULL DEFAULT 0 CHECK (can_admin IN (0, 1)),
  created_at    INTEGER NOT NULL,
  created_by    TEXT REFERENCES principals(id),
  CHECK (kind != 'system' OR (role = 'member' AND can_admin = 0)),
  CHECK (password_hash IS NULL OR kind = 'human'),
  UNIQUE (tenant_id, name)
) STRICT;

CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  hash         TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  created_by   TEXT REFERENCES principals(id),
  expires_at   INTEGER,
  revoked_at   INTEGER,
  revoked_by   TEXT REFERENCES principals(id),
  last_used_at INTEGER,
  last_used_ip TEXT
) STRICT;
CREATE INDEX tokens_principal ON tokens(principal_id);

CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT
) STRICT;
CREATE INDEX sessions_principal ON sessions(principal_id);

CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system      INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  created_at  INTEGER NOT NULL,
  created_by  TEXT REFERENCES principals(id),
  UNIQUE (tenant_id, name)
) STRICT;

CREATE TABLE group_members (
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  added_by     TEXT REFERENCES principals(id),
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (group_id, principal_id)
) STRICT;
CREATE INDEX group_members_principal ON group_members(principal_id);

-- Spaces and grants -----------------------------------------------------------

CREATE TABLE spaces (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  slug                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  review_mode          TEXT NOT NULL DEFAULT 'off' CHECK (review_mode IN ('off', 'limited', 'all')),
  executable           INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  ttl_days             INTEGER CHECK (ttl_days IS NULL OR ttl_days > 0),
  trash_retention_days INTEGER CHECK (trash_retention_days IS NULL OR trash_retention_days > 0),
  quota_bytes          INTEGER NOT NULL DEFAULT 524288000 CHECK (quota_bytes > 0),
  max_doc_bytes        INTEGER CHECK (max_doc_bytes IS NULL OR max_doc_bytes > 0),
  protected_paths      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(protected_paths)),
  bytes_used           INTEGER NOT NULL DEFAULT 0,
  archived_at          INTEGER,
  archived_by          TEXT REFERENCES principals(id),
  created_at           INTEGER NOT NULL,
  created_by           TEXT REFERENCES principals(id),
  UNIQUE (tenant_id, slug)
) STRICT;

CREATE TABLE grants (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  scope        TEXT NOT NULL CHECK (scope IN ('space', 'path', 'doc')),
  path_prefix  TEXT,
  doc_id       TEXT REFERENCES documents(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('principal', 'group')),
  subject_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('none', 'read', 'propose', 'write', 'admin')),
  granted_by   TEXT REFERENCES principals(id),
  granted_at   INTEGER NOT NULL,
  CHECK (
    (scope = 'space' AND path_prefix IS NULL AND doc_id IS NULL) OR
    (scope = 'path' AND path_prefix IS NOT NULL AND path_prefix LIKE '%/' AND doc_id IS NULL) OR
    (scope = 'doc' AND path_prefix IS NULL AND doc_id IS NOT NULL)
  )
) STRICT;
-- Uniqueness: three partial indexes, one per scope kind, with no nullable columns in the key.
-- path_prefix is stored in path_key form (NFC, lower case): comparison is case-insensitive.
CREATE UNIQUE INDEX grants_unique_space ON grants(space_id, subject_type, subject_id) WHERE scope = 'space';
CREATE UNIQUE INDEX grants_unique_path ON grants(space_id, path_prefix, subject_type, subject_id) WHERE scope = 'path';
CREATE UNIQUE INDEX grants_unique_doc ON grants(space_id, doc_id, subject_type, subject_id) WHERE scope = 'doc';
CREATE INDEX grants_space ON grants(space_id);
CREATE INDEX grants_subject ON grants(subject_type, subject_id);
CREATE INDEX grants_doc ON grants(doc_id) WHERE doc_id IS NOT NULL;

-- Documents and revisions -----------------------------------------------------

CREATE TABLE documents (
  num           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  space_id      TEXT NOT NULL REFERENCES spaces(id),
  path          TEXT NOT NULL,
  path_key      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('text', 'file')),
  mime          TEXT NOT NULL,
  title         TEXT NOT NULL,
  meta          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  head_rev      INTEGER NOT NULL CHECK (head_rev >= 1),
  head_seq      INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  attribution   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attribution)),
  trust_floor   TEXT NOT NULL CHECK (trust_floor IN ('admin', 'trusted', 'limited')),
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL REFERENCES principals(id),
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL REFERENCES principals(id),
  deleted_at    INTEGER,
  deleted_by    TEXT REFERENCES principals(id),
  expires_at    INTEGER,
  read_count    INTEGER NOT NULL DEFAULT 0,
  last_read_at  INTEGER
);
CREATE UNIQUE INDEX documents_live_path ON documents(space_id, path_key) WHERE deleted_at IS NULL;
CREATE INDEX documents_space_path ON documents(space_id, path_key);
CREATE INDEX documents_expires ON documents(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX documents_deleted ON documents(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE blobs (
  hash       TEXT PRIMARY KEY,
  storage    TEXT NOT NULL CHECK (storage IN ('inline', 'file')),
  text       TEXT,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((storage = 'inline') = (text IS NOT NULL))
) STRICT;

CREATE TABLE proposals (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL REFERENCES spaces(id),
  doc_id         TEXT REFERENCES documents(id),
  path           TEXT NOT NULL,
  base_rev       INTEGER NOT NULL DEFAULT 0 CHECK (base_rev >= 0),
  content_hash   TEXT NOT NULL,
  message        TEXT NOT NULL DEFAULT '',
  author_id      TEXT NOT NULL REFERENCES principals(id),
  author_trust   TEXT NOT NULL CHECK (author_trust IN ('admin', 'trusted', 'limited')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn')),
  created_at     INTEGER NOT NULL,
  decided_by     TEXT REFERENCES principals(id),
  decided_at     INTEGER,
  decision_note  TEXT,
  result_seq     INTEGER
) STRICT;
CREATE INDEX proposals_space_status ON proposals(space_id, status);
CREATE INDEX proposals_author_status ON proposals(author_id, status);
CREATE INDEX proposals_doc ON proposals(doc_id) WHERE doc_id IS NOT NULL;

CREATE TABLE revisions (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id         TEXT NOT NULL REFERENCES documents(id),
  rev            INTEGER NOT NULL CHECK (rev >= 1),
  kind           TEXT NOT NULL CHECK (kind IN ('create', 'update', 'move', 'delete', 'restore', 'revert', 'undo', 'expire', 'import')),
  space_id       TEXT NOT NULL REFERENCES spaces(id),
  path           TEXT NOT NULL,
  prev_space_id  TEXT REFERENCES spaces(id),
  prev_path      TEXT,
  content_hash   TEXT NOT NULL,
  size           INTEGER NOT NULL,
  author_id      TEXT NOT NULL REFERENCES principals(id),
  author_trust   TEXT NOT NULL CHECK (author_trust IN ('admin', 'trusted', 'limited')),
  approved_by    TEXT REFERENCES principals(id),
  proposal_id    TEXT REFERENCES proposals(id),
  via            TEXT NOT NULL CHECK (via IN ('mcp', 'mcpl', 'rest', 'ui', 'cli', 'import', 'system')),
  message        TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 500),
  ref_rev        INTEGER,
  attention      INTEGER NOT NULL DEFAULT 0 CHECK (attention IN (0, 1)),
  created_at     INTEGER NOT NULL,
  purged_at      INTEGER,
  purged_by      TEXT REFERENCES principals(id),
  UNIQUE (doc_id, rev)
);
CREATE INDEX revisions_space_seq ON revisions(space_id, seq);
CREATE INDEX revisions_author_seq ON revisions(author_id, seq);
CREATE INDEX revisions_attention ON revisions(seq) WHERE attention = 1;

-- Revision immutability: only purged_* may change.
CREATE TRIGGER revisions_immutable
BEFORE UPDATE ON revisions
WHEN NEW.seq IS NOT OLD.seq OR NEW.doc_id IS NOT OLD.doc_id OR NEW.rev IS NOT OLD.rev
  OR NEW.kind IS NOT OLD.kind OR NEW.space_id IS NOT OLD.space_id OR NEW.path IS NOT OLD.path
  OR NEW.prev_space_id IS NOT OLD.prev_space_id OR NEW.prev_path IS NOT OLD.prev_path
  OR NEW.content_hash IS NOT OLD.content_hash OR NEW.size IS NOT OLD.size
  OR NEW.author_id IS NOT OLD.author_id OR NEW.author_trust IS NOT OLD.author_trust
  OR NEW.approved_by IS NOT OLD.approved_by OR NEW.proposal_id IS NOT OLD.proposal_id
  OR NEW.via IS NOT OLD.via OR NEW.message IS NOT OLD.message OR NEW.ref_rev IS NOT OLD.ref_rev
  OR NEW.attention IS NOT OLD.attention OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TABLE doc_ystate (
  doc_id   TEXT PRIMARY KEY REFERENCES documents(id),
  state    BLOB NOT NULL,
  head_rev INTEGER NOT NULL
) STRICT;

CREATE TABLE yclients (
  doc_id       TEXT NOT NULL REFERENCES documents(id),
  client_id    INTEGER NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  PRIMARY KEY (doc_id, client_id),
  UNIQUE (doc_id, principal_id)
) STRICT;

-- Search: stem strings; rowid = documents.num.
CREATE VIRTUAL TABLE fts_docs USING fts5(
  title, path, tags, headings, body,
  tokenize = 'unicode61',
  prefix = '2 3 4'
);

-- Proposals, attention, housekeeping ------------------------------------------

CREATE TABLE cursors (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  seq          INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE doc_seen (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  doc_id       TEXT NOT NULL REFERENCES documents(id),
  rev          INTEGER NOT NULL,
  seen_at      INTEGER NOT NULL,
  PRIMARY KEY (principal_id, doc_id)
) STRICT;

CREATE TABLE idempotency (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  request_id   TEXT NOT NULL,
  op           TEXT NOT NULL,
  input_hash   TEXT NOT NULL,
  response     TEXT NOT NULL CHECK (json_valid(response)),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (principal_id, request_id)
) STRICT;
CREATE INDEX idempotency_created ON idempotency(created_at);

CREATE TABLE audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  principal_id TEXT,
  token_id     TEXT,
  via          TEXT NOT NULL,
  op           TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  space_id     TEXT,
  doc_id       TEXT,
  rev          INTEGER,
  request_id   TEXT,
  ip           TEXT,
  detail       TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 1024))
);
CREATE INDEX audit_ts ON audit(ts);
CREATE INDEX audit_principal_ts ON audit(principal_id, ts);
CREATE INDEX audit_doc_ts ON audit(doc_id, ts);

CREATE TABLE webhooks (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  secret         TEXT NOT NULL,
  events         TEXT NOT NULL DEFAULT '["revision.created"]' CHECK (json_valid(events)),
  space_id       TEXT REFERENCES spaces(id),
  attention_only INTEGER NOT NULL DEFAULT 0 CHECK (attention_only IN (0, 1)),
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at     INTEGER NOT NULL,
  created_by     TEXT REFERENCES principals(id)
) STRICT;

CREATE TABLE webhook_outbox (
  id              INTEGER PRIMARY KEY,
  webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  payload         TEXT NOT NULL CHECK (json_valid(payload)),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  delivered_at    INTEGER,
  last_error      TEXT
) STRICT;
CREATE INDEX webhook_outbox_pending ON webhook_outbox(next_attempt_at) WHERE delivered_at IS NULL;

CREATE TABLE exports (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  file         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
) STRICT;
