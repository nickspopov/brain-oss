-- External principals and no ambient access to inbox and proj-* spaces.

-- External principal: another person's agent. `owner_label` is that person (free text, not a principal).
-- `limits` is JSON with per-principal limits; NULL = defaults (core/external.ts); a null field = no limit.
ALTER TABLE principals ADD COLUMN external INTEGER NOT NULL DEFAULT 0 CHECK (external IN (0, 1));
ALTER TABLE principals ADD COLUMN owner_label TEXT;
ALTER TABLE principals ADD COLUMN limits TEXT;

-- The computed group all-agents no longer gives access to inbox spaces or proj-* spaces. Grants it
-- already had there become explicit principal grants of the agents who had them through it (enabled
-- agents without a grant of their own on the same key), so nobody loses or gains access today.
INSERT INTO grants (id, space_id, scope, path_prefix, doc_id, subject_type, subject_id, role, granted_by, granted_at)
SELECT 'mig8' || lower(hex(randomblob(11))), g.space_id, g.scope, g.path_prefix, g.doc_id, 'principal', p.id, g.role, g.granted_by, g.granted_at
FROM grants g
JOIN groups gr ON gr.id = g.subject_id AND gr.name = 'all-agents' AND gr.system = 1
JOIN spaces s ON s.id = g.space_id AND (s.inbox = 1 OR s.slug LIKE 'proj-%')
JOIN principals p ON p.tenant_id = gr.tenant_id AND p.kind = 'agent' AND p.disabled_at IS NULL
WHERE g.subject_type = 'group'
  AND NOT EXISTS (
    SELECT 1 FROM grants x
    WHERE x.space_id = g.space_id AND x.scope = g.scope AND x.subject_type = 'principal' AND x.subject_id = p.id
      AND x.path_prefix IS g.path_prefix AND x.doc_id IS g.doc_id
  );
DELETE FROM grants
WHERE subject_type = 'group'
  AND subject_id IN (SELECT id FROM groups WHERE name = 'all-agents' AND system = 1)
  AND space_id IN (SELECT id FROM spaces WHERE inbox = 1 OR slug LIKE 'proj-%');

-- A recipient now needs an explicit principal grant in the inbox space; the owner (an enabled human
-- superadmin) was a recipient through superadmin, so give it one where it has none.
INSERT INTO grants (id, space_id, scope, path_prefix, doc_id, subject_type, subject_id, role, granted_by, granted_at)
SELECT 'mig8' || lower(hex(randomblob(11))), s.id, 'space', NULL, NULL, 'principal', p.id, 'admin', NULL, s.created_at
FROM spaces s
JOIN principals p ON p.tenant_id = s.tenant_id AND p.kind = 'human' AND p.role = 'superadmin' AND p.disabled_at IS NULL
WHERE s.inbox = 1
  AND NOT EXISTS (
    SELECT 1 FROM grants x WHERE x.space_id = s.id AND x.subject_type = 'principal' AND x.subject_id = p.id
  );

-- External sends per day and pending per recipient.
CREATE INDEX handoff_messages_sender_recipient ON handoff_messages (sender_id, recipient_id);
