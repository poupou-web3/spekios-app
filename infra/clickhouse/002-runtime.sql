CREATE TABLE IF NOT EXISTS scout.runtime_events
(
  event_id UUID,
  workspace_id UUID,
  user_id UUID,
  run_id UUID,
  seq UInt64,
  event_type LowCardinality(String),
  action_id Nullable(UUID),
  occurred_at DateTime64(3, 'UTC'),
  payload String
)
ENGINE = ReplacingMergeTree
ORDER BY (workspace_id,run_id,event_id);

CREATE VIEW IF NOT EXISTS scout.runtime_events_current AS
SELECT * FROM scout.runtime_events FINAL;
