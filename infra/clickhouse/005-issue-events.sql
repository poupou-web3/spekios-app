CREATE TABLE IF NOT EXISTS scout.issue_events (
 event_id UUID,
 workspace_id UUID,
 issue_id UUID,
 seq Int64,
 event_type LowCardinality(String),
 occurred_at DateTime64(3, 'UTC'),
 payload String
) ENGINE=ReplacingMergeTree ORDER BY(workspace_id,issue_id,event_id);
CREATE OR REPLACE VIEW scout.issue_events_current AS SELECT * FROM scout.issue_events FINAL;
