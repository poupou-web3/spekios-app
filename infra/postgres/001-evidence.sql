CREATE TABLE IF NOT EXISTS evidence_blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bucket text NOT NULL,
  object_key text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  media_type text NOT NULL,
  UNIQUE (bucket, object_key)
);

-- Design-reference archive only: browser action tables are a later increment.
CREATE TABLE IF NOT EXISTS reference_captures (
  capture_id uuid PRIMARY KEY,
  archive_id uuid NOT NULL,
  sha256 text NOT NULL REFERENCES evidence_blobs(sha256),
  source_filename text NOT NULL,
  ingested_at timestamptz NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'design_reference'),
  training_status text NOT NULL CHECK (training_status = 'excluded_reference'),
  UNIQUE (archive_id, source_filename)
);

CREATE TABLE IF NOT EXISTS evidence_outbox (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  exported_at timestamptz
);
