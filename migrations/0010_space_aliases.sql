-- Messages live in the space they belong to.
-- `brain migrate-spaces --apply` re-homes an inbox space into its project space; the old row stays as an
-- alias of the canonical one (`alias_of`): its slug and id resolve to the canonical space, it holds no
-- documents, grants on it are never in effect, it is archived and hidden everywhere.
ALTER TABLE spaces ADD COLUMN alias_of TEXT REFERENCES spaces(id);
CREATE INDEX spaces_alias_of ON spaces(alias_of) WHERE alias_of IS NOT NULL;

-- `handoff` keeps its slug and id; its display name becomes "General" unless an operator renamed it.
UPDATE spaces SET name = 'General' WHERE slug = 'handoff' AND name IN ('handoff', 'Handoff');
