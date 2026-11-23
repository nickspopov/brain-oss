-- Role `guest` — a messaging-only membership
-- of an inbox space. SQLite cannot widen a CHECK in place, so the grants table is rebuilt with the
-- same columns, rows and indexes; nothing else references it. No grant changes here: Guest is set only
-- explicitly (existing externals stay message-only through their own code path).
CREATE TABLE grants_new (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  scope        TEXT NOT NULL CHECK (scope IN ('space', 'path', 'doc')),
  path_prefix  TEXT,
  doc_id       TEXT REFERENCES documents(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('principal', 'group')),
  subject_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('none', 'guest', 'read', 'propose', 'write', 'admin')),
  granted_by   TEXT REFERENCES principals(id),
  granted_at   INTEGER NOT NULL,
  CHECK (
    (scope = 'space' AND path_prefix IS NULL AND doc_id IS NULL) OR
    (scope = 'path' AND path_prefix IS NOT NULL AND path_prefix LIKE '%/' AND doc_id IS NULL) OR
    (scope = 'doc' AND path_prefix IS NULL AND doc_id IS NOT NULL)
  ),
  -- Guest is a personal membership of the whole space.
  CHECK (role != 'guest' OR (scope = 'space' AND subject_type = 'principal'))
) STRICT;
INSERT INTO grants_new (id, space_id, scope, path_prefix, doc_id, subject_type, subject_id, role, granted_by, granted_at)
  SELECT id, space_id, scope, path_prefix, doc_id, subject_type, subject_id, role, granted_by, granted_at FROM grants;
DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;
CREATE UNIQUE INDEX grants_unique_space ON grants(space_id, subject_type, subject_id) WHERE scope = 'space';
CREATE UNIQUE INDEX grants_unique_path ON grants(space_id, path_prefix, subject_type, subject_id) WHERE scope = 'path';
CREATE UNIQUE INDEX grants_unique_doc ON grants(space_id, doc_id, subject_type, subject_id) WHERE scope = 'doc';
CREATE INDEX grants_space ON grants(space_id);
CREATE INDEX grants_subject ON grants(subject_type, subject_id);
CREATE INDEX grants_doc ON grants(doc_id) WHERE doc_id IS NOT NULL;
