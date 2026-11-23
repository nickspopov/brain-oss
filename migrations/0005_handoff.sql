-- Time of the principal's last successful start_here (inbox "(new)" marks);
-- agent cards handoff/_agents/… never expire.
ALTER TABLE principals ADD COLUMN last_start_here_at INTEGER;
UPDATE documents SET expires_at = NULL
  WHERE expires_at IS NOT NULL
    AND substr(path_key, 1, 8) = '_agents/'
    AND space_id IN (SELECT id FROM spaces WHERE slug = 'handoff');
