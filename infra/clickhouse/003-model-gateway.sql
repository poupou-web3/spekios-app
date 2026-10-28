CREATE TABLE IF NOT EXISTS scout.model_events
(
  event_id UUID,
  workspace_id UUID,
  user_id UUID,
  request_id UUID,
  call_id Nullable(UUID),
  event_type LowCardinality(String),
  occurred_at DateTime64(3, 'UTC'),
  provider LowCardinality(String),
  requested_model String,
  execution_mode LowCardinality(String),
  run_id Nullable(UUID),
  action_id Nullable(UUID),
  payload String
)
ENGINE = ReplacingMergeTree
ORDER BY (workspace_id,request_id,event_id);
ALTER TABLE scout.model_events ADD COLUMN IF NOT EXISTS execution_mode LowCardinality(String) DEFAULT 'live';

CREATE OR REPLACE VIEW scout.model_events_current AS
SELECT * FROM scout.model_events FINAL;

-- Only final events contribute to usage. Retransmitted outbox events deduplicate
-- by event_id before aggregation. Unknown fields remain NULL.
CREATE OR REPLACE VIEW scout.model_usage AS
SELECT workspace_id,user_id,request_id,call_id,provider,requested_model,execution_mode,occurred_at,
  JSONExtract(payload,'input_tokens','Nullable(Int64)') AS input_tokens,
  JSONExtract(payload,'output_tokens','Nullable(Int64)') AS output_tokens,
  JSONExtractString(payload,'usage_status') AS usage_status,
  JSONExtractString(payload,'state') AS state
FROM scout.model_events_current WHERE event_type='call_finished';
