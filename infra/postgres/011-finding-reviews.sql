-- Human labels are a separate immutable overlay. Original predictions, model
-- assessments, reproduction results and historical manifests remain unchanged.
CREATE TABLE IF NOT EXISTS finding_reviews (
  review_id uuid PRIMARY KEY,
  action_id uuid NOT NULL,
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  disposition text NOT NULL CHECK (disposition IN ('confirmed','dismissed','needs_review')),
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) BETWEEN 1 AND 2000),
  expectation_basis text NOT NULL CHECK (char_length(expectation_basis) <= 2000),
  severity text CHECK (severity IN ('low','medium','high','critical')),
  evidence_snapshot jsonb NOT NULL CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,action_id) REFERENCES runtime_actions(run_id,action_id),
  UNIQUE (action_id,revision),
  CHECK (disposition <> 'confirmed' OR (char_length(btrim(expectation_basis)) >= 10 AND severity IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS finding_reviews_run ON finding_reviews(run_id,created_at,review_id);

CREATE OR REPLACE FUNCTION reject_finding_review_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Finding review history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS finding_reviews_append_only ON finding_reviews;
CREATE TRIGGER finding_reviews_append_only BEFORE UPDATE OR DELETE ON finding_reviews
FOR EACH ROW EXECUTE FUNCTION reject_finding_review_mutation();
