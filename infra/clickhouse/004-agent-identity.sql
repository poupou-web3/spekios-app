CREATE TABLE IF NOT EXISTS scout.identity_audit
(
  event_id UUID,
  workspace_id UUID,
  agent_id Nullable(UUID),
  credential_id Nullable(UUID),
  operation LowCardinality(String),
  outcome LowCardinality(String),
  occurred_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
ORDER BY (workspace_id,event_id);
ALTER TABLE scout.identity_audit ADD COLUMN IF NOT EXISTS request_id Nullable(UUID);
CREATE OR REPLACE VIEW scout.identity_audit_current AS SELECT * FROM scout.identity_audit FINAL;

ALTER TABLE scout.model_events ADD COLUMN IF NOT EXISTS agent_id Nullable(UUID);
CREATE OR REPLACE VIEW scout.model_events_current AS SELECT * FROM scout.model_events FINAL;
CREATE OR REPLACE VIEW scout.agent_model_usage AS
SELECT workspace_id,agent_id,request_id,call_id,provider,requested_model,execution_mode,occurred_at,
  JSONExtract(payload,'input_tokens','Nullable(Int64)') AS input_tokens,
  JSONExtract(payload,'output_tokens','Nullable(Int64)') AS output_tokens,
  JSONExtractString(payload,'usage_status') AS usage_status
FROM scout.model_events_current WHERE event_type='call_finished';
