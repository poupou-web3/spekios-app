-- An app memory scope includes its screen size, not just its profile name.
-- Profiles can change size (desktop went from 800 × 600 to 1920 × 1080), and
-- memory, the app map and reused rankings recorded at one size should not
-- steer runs at another. Existing scopes keep the size of their last run, or
-- the size their profile had before this change.
ALTER TABLE app_memory_scopes ADD COLUMN IF NOT EXISTS viewport_width integer, ADD COLUMN IF NOT EXISTS viewport_height integer;
UPDATE app_memory_scopes s SET
  viewport_width = COALESCE((SELECT (r.config->'viewport'->>'width')::integer FROM runtime_runs r WHERE r.run_id=s.last_run_id),
    CASE s.viewport_profile WHEN 'desktop' THEN 800 WHEN 'tablet' THEN 768 ELSE 390 END),
  viewport_height = COALESCE((SELECT (r.config->'viewport'->>'height')::integer FROM runtime_runs r WHERE r.run_id=s.last_run_id),
    CASE s.viewport_profile WHEN 'desktop' THEN 600 WHEN 'tablet' THEN 1024 ELSE 844 END)
WHERE s.viewport_width IS NULL OR s.viewport_height IS NULL;
ALTER TABLE app_memory_scopes ALTER COLUMN viewport_width SET NOT NULL, ALTER COLUMN viewport_height SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_memory_scopes'::regclass AND conname='app_memory_scopes_viewport_size') THEN
    ALTER TABLE app_memory_scopes ADD CONSTRAINT app_memory_scopes_viewport_size
      CHECK (viewport_width BETWEEN 1 AND 8192 AND viewport_height BETWEEN 1 AND 8192);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS app_memory_scopes_identity
  ON app_memory_scopes(workspace_id,user_id,origin,viewport_profile,viewport_width,viewport_height,auth_scope,execution_mode);
-- The original key without the size would still merge sizes; drop it.
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app_memory_scopes'::regclass AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (workspace_id, user_id, origin, viewport_profile, auth_scope, execution_mode)' LOOP
    EXECUTE format('ALTER TABLE app_memory_scopes DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
