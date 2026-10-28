CREATE TABLE IF NOT EXISTS scout.evidence_events
(
  event_id UUID,
  event_type LowCardinality(String),
  occurred_at DateTime64(3, 'UTC'),
  archive_id UUID,
  capture_id UUID,
  sha256 FixedString(64),
  byte_length UInt64,
  bucket String,
  object_key String,
  purpose LowCardinality(String),
  training_status LowCardinality(String)
)
ENGINE = ReplacingMergeTree
ORDER BY event_id;

-- Repeated delivery is normal. Query this view for logical event counts.
CREATE VIEW IF NOT EXISTS scout.evidence_events_current AS
SELECT * FROM scout.evidence_events FINAL;
