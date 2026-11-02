-- Provider credentials never enter preferences, jobs, evidence or analytics.
-- The encryption key lives outside PostgreSQL in SCOUT_PROVIDER_VAULT_KEY.
CREATE TABLE IF NOT EXISTS provider_keys (
  key_id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('personal','demo')),
  workspace_id uuid REFERENCES workspaces(workspace_id),
  user_id uuid,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','openrouter','meta')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  encrypted_key bytea NOT NULL,
  secret_sha256 text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((scope='personal' AND workspace_id IS NOT NULL AND user_id IS NOT NULL)
      OR (scope='demo' AND workspace_id IS NULL AND user_id IS NULL AND provider='meta'))
);
CREATE INDEX IF NOT EXISTS provider_keys_owner ON provider_keys(workspace_id,user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS provider_keys_default ON provider_keys(workspace_id,user_id,provider)
  WHERE scope='personal' AND is_default AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS demo_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  allowance_microusd bigint NOT NULL DEFAULT 1000000 CHECK (allowance_microusd BETWEEN 0 AND 1000000000),
  model text NOT NULL DEFAULT 'muse-spark-1.3-contributor'
    CHECK (model = 'muse-spark-1.3-contributor'),
  key_id uuid REFERENCES provider_keys(key_id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO demo_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;

-- Lock one account row before reserving. All workspaces, runs and retries for
-- that account share the same lifetime allowance. Reservations survive restart.
CREATE TABLE IF NOT EXISTS demo_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS demo_reservations (
  call_id uuid PRIMARY KEY REFERENCES model_calls(call_id),
  user_id uuid NOT NULL REFERENCES demo_accounts(user_id),
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd > 0),
  charged_microusd bigint CHECK (charged_microusd >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','settled','held')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS demo_reservations_account ON demo_reservations(user_id);
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS funding_source text NOT NULL DEFAULT 'operator'
  CHECK (funding_source IN ('operator','personal','demo'));
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS provider_key_id uuid REFERENCES provider_keys(key_id);
