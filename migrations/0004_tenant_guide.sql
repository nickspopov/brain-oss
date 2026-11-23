-- Owner-editable guide text shown by start_here (NULL = built-in default, ≤ 1500 chars).
ALTER TABLE tenants ADD COLUMN guide_text TEXT CHECK (guide_text IS NULL OR length(guide_text) <= 1500);
