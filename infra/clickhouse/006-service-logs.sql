-- Every container line from the Compose project, shipped by infra/logs/vector.yaml.
-- ts is when Docker read the line. ingested_at is when this server stored it:
-- the collector inserts one batch at a time, so ingested_at only moves forward
-- and the back office tails on it without skipping lines that arrive late.
-- log_id hashes the container, stream, timestamp and text, so a line the
-- collector reads twice merges away; the viewer also drops repeats by log_id.
CREATE TABLE IF NOT EXISTS scout.service_logs
(
  log_id UUID,
  ts DateTime64(9, 'UTC'),
  ingested_at DateTime64(6, 'UTC') DEFAULT now64(6),
  service LowCardinality(String),
  replica LowCardinality(String),
  stream LowCardinality(String),
  level LowCardinality(String),
  message String,
  fields String,
  run_id String,
  request_id String,
  INDEX ingested ingested_at TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (ts, log_id)
TTL toDateTime(ts) + INTERVAL 14 DAY
SETTINGS ttl_only_drop_parts = 1;
