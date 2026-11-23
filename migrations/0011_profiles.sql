-- One profile per agent or person,
-- built from principal fields. `what_i_do` is the one-line "what I do"; `contact_notes` is how to reach it
-- and its response times. Both are written by the principal itself (`profile_update`) or a Brain
-- administrator; never filled automatically from `_agents/<name>.md` cards (those stay as legacy documents,
-- their extracted fields are only suggestions until a human accepts them).
ALTER TABLE principals ADD COLUMN what_i_do TEXT;
ALTER TABLE principals ADD COLUMN contact_notes TEXT;
ALTER TABLE principals ADD COLUMN profile_updated_at INTEGER;
