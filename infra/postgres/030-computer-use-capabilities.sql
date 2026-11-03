-- Compatibility probes are rare; ordinary inference never enters this index.
-- Capability discovery runs on account refresh and must not scan run history.
CREATE INDEX IF NOT EXISTS model_requests_computer_probe
ON model_requests(workspace_id,user_id,execution_mode,model,funding_source,provider_key_id,created_at DESC)
WHERE provider='meta' AND spec->>'computer_use_probe'='true' AND state='completed';
