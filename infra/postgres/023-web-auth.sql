-- Human sign-in is separate from agent credentials and the bootstrap operator.
CREATE TABLE IF NOT EXISTS web_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(workspace_id),
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  UNIQUE (user_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS web_login_attempts (
  cookie_sha256 text PRIMARY KEY,
  state_sha256 text NOT NULL,
  verifier text NOT NULL,
  return_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS web_login_expiry ON web_login_attempts(expires_at);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_sha256 text PRIMARY KEY,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours',
  FOREIGN KEY (user_id, workspace_id) REFERENCES web_identities(user_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS web_session_expiry ON web_sessions(expires_at);
