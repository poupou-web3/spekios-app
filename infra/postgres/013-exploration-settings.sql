-- Nonsecret user preferences only. Origin/network policy and credentials stay
-- in operator configuration; each admitted job freezes its effective snapshot.
CREATE TABLE IF NOT EXISTS exploration_settings_versions (
  request_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0 AND expected_revision < 9223372036854775807),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,user_id,revision),
  CHECK (revision = expected_revision + 1)
);

CREATE OR REPLACE FUNCTION reject_exploration_settings_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Exploration settings history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS exploration_settings_append_only ON exploration_settings_versions;
CREATE TRIGGER exploration_settings_append_only BEFORE UPDATE OR DELETE ON exploration_settings_versions
FOR EACH ROW EXECUTE FUNCTION reject_exploration_settings_mutation();
