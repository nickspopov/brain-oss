-- Downloading an archive re-checks current access to every object inside. For that, the export row
-- stores the mode, the ids of the archived documents and the sha256 of the file.
ALTER TABLE exports ADD COLUMN mode TEXT NOT NULL DEFAULT 'head' CHECK (mode IN ('head', 'full'));
ALTER TABLE exports ADD COLUMN doc_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(doc_ids));
ALTER TABLE exports ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
