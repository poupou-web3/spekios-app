-- Persistent issue identity is independent of an individual model assessment.
-- Human review remains separate; verification only describes one candidate.
CREATE TABLE IF NOT EXISTS issues (
  issue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  user_id uuid NOT NULL,
  fingerprint text NOT NULL,
  source_run_id uuid NOT NULL,
  source_action_id uuid NOT NULL,
  source_target_url text NOT NULL,
  snapshot jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,user_id,fingerprint),
  UNIQUE(issue_id,workspace_id),
  FOREIGN KEY(source_run_id,source_action_id) REFERENCES runtime_actions(run_id,action_id)
);
CREATE TABLE IF NOT EXISTS issue_occurrences (
  action_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(issue_id,workspace_id) REFERENCES issues(issue_id,workspace_id),
  FOREIGN KEY(run_id,action_id) REFERENCES runtime_actions(run_id,action_id)
);
CREATE INDEX IF NOT EXISTS issue_occurrences_issue ON issue_occurrences(issue_id,created_at,action_id);
CREATE INDEX IF NOT EXISTS issues_recent ON issues(workspace_id,last_seen_at DESC,issue_id);
CREATE TABLE IF NOT EXISTS issue_verifications (
  verification_id uuid PRIMARY KEY,
  issue_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES browser_jobs(job_id),
  run_id uuid UNIQUE REFERENCES runtime_runs(run_id),
  candidate_url text NOT NULL,
  deployment_ref text,
  source_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed')),
  outcome text CHECK(outcome IN ('resolved','still_reproducible','blocked','inconclusive')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY(issue_id,workspace_id) REFERENCES issues(issue_id,workspace_id),
  CHECK((status='completed')=(outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS issue_verifications_history ON issue_verifications(issue_id,created_at DESC,verification_id);
CREATE TABLE IF NOT EXISTS issue_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  seq bigint NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  exported_at timestamptz,
  FOREIGN KEY(issue_id,workspace_id) REFERENCES issues(issue_id,workspace_id),
  UNIQUE(issue_id,seq)
);
CREATE INDEX IF NOT EXISTS issue_events_pending ON issue_events(occurred_at) WHERE exported_at IS NULL;

CREATE OR REPLACE FUNCTION scout_preserve_issue_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Issue history is append-only'; END IF;
 IF TG_TABLE_NAME='issues' AND (to_jsonb(NEW)-'revision'-'last_seen_at') IS DISTINCT FROM (to_jsonb(OLD)-'revision'-'last_seen_at') THEN
   RAISE EXCEPTION 'Original issue identity and evidence are immutable';
 ELSIF TG_TABLE_NAME='issue_occurrences' THEN RAISE EXCEPTION 'Issue occurrences are append-only';
 ELSIF TG_TABLE_NAME='issue_events' AND (to_jsonb(NEW)-'exported_at') IS DISTINCT FROM (to_jsonb(OLD)-'exported_at') THEN
   RAISE EXCEPTION 'Issue events are append-only';
 ELSIF TG_TABLE_NAME='issue_verifications' THEN
   IF (to_jsonb(NEW)-'status'-'outcome'-'result'-'run_id'-'finished_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'outcome'-'result'-'run_id'-'finished_at') THEN
     RAISE EXCEPTION 'Candidate admission and frozen source are immutable';
   END IF;
   IF OLD.outcome IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Completed verification is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scout_preserve_issue ON issues;
CREATE TRIGGER scout_preserve_issue BEFORE UPDATE OR DELETE ON issues FOR EACH ROW EXECUTE FUNCTION scout_preserve_issue_record();
DROP TRIGGER IF EXISTS scout_preserve_occurrence ON issue_occurrences;
CREATE TRIGGER scout_preserve_occurrence BEFORE UPDATE OR DELETE ON issue_occurrences FOR EACH ROW EXECUTE FUNCTION scout_preserve_issue_record();
DROP TRIGGER IF EXISTS scout_preserve_verification ON issue_verifications;
CREATE TRIGGER scout_preserve_verification BEFORE UPDATE OR DELETE ON issue_verifications FOR EACH ROW EXECUTE FUNCTION scout_preserve_issue_record();
DROP TRIGGER IF EXISTS scout_preserve_issue_event ON issue_events;
CREATE TRIGGER scout_preserve_issue_event BEFORE UPDATE OR DELETE ON issue_events FOR EACH ROW EXECUTE FUNCTION scout_preserve_issue_record();

CREATE OR REPLACE FUNCTION scout_command_identity(command jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT (command-'control') || CASE WHEN command ? 'control' THEN jsonb_build_object('control',(command->'control')-'control_id'-'rect'-'occluded') ELSE '{}'::jsonb END
$$;
CREATE OR REPLACE FUNCTION scout_issue_path(source_run uuid, source_ordinal integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('action_id',action_id,'state',state,'spec',spec,'before_capture_id',before_capture_id,'after_capture_id',after_capture_id,'comparison',comparison,'tool_error',tool_error,'assessment',assessment) ORDER BY ordinal),'[]'::jsonb)
 FROM runtime_actions WHERE run_id=source_run AND ordinal<=source_ordinal
$$;
CREATE OR REPLACE FUNCTION scout_record_issue(action runtime_actions) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source runtime_runs; identity_key text; recorded issues; path_identity jsonb;
BEGIN
 IF action.state<>'completed' OR action.assessment->>'verdict' IS DISTINCT FROM 'suspect'
    OR action.assessment->'expectation_uncertain' IS DISTINCT FROM 'false'::jsonb
    OR action.tool_error IS NOT NULL OR action.spec->'prediction'->>'source' IS DISTINCT FROM 'model'
    OR EXISTS(SELECT 1 FROM issue_occurrences WHERE action_id=action.action_id) THEN RETURN; END IF;
 SELECT * INTO source FROM runtime_runs WHERE run_id=action.run_id;
 IF source.config->>'runtime_version' IS DISTINCT FROM 'explorer-v1' OR source.config->>'replay_of' IS NOT NULL OR source.config->>'fix_verification' IS NOT NULL THEN RETURN; END IF;
 IF NULLIF(btrim(action.spec->'prediction'->>'expected_result'),'') IS NULL OR action.before_capture_id IS NULL OR action.after_capture_id IS NULL THEN RETURN; END IF;
 SELECT jsonb_agg(jsonb_build_object('command',scout_command_identity(spec->'command'),'expected',spec->'prediction'->>'expected_result') ORDER BY ordinal)
 INTO path_identity FROM runtime_actions WHERE run_id=action.run_id AND ordinal<=action.ordinal AND state<>'skipped';
 identity_key=encode(sha256(convert_to(jsonb_build_object('entry_url',source.target_url,'viewport',source.config->'viewport','auth_session',(
   SELECT context->>'session_id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(source.config->'auth_contexts')='array' THEN source.config->'auth_contexts' ELSE '[]'::jsonb END) context WHERE context->>'context_id'=action.spec->>'auth_context_id' LIMIT 1
 ),'path',path_identity)::text,'UTF8')),'hex');
 INSERT INTO issues(workspace_id,user_id,fingerprint,source_run_id,source_action_id,source_target_url,snapshot)
 VALUES(source.workspace_id,source.user_id,identity_key,action.run_id,action.action_id,source.target_url,jsonb_build_object(
   'title',left(COALESCE(action.spec->'prediction'->>'goal','Recorded behavior mismatch'),300),
   'expected_result',action.spec->'prediction'->>'expected_result','observed_result',action.assessment->>'observed_result',
   'reason',action.assessment->>'reason','command',action.spec->'command','prediction_id',action.prediction_id,
   'before_capture_id',action.before_capture_id,'after_capture_id',action.after_capture_id,'viewport_profile',source.config->>'viewport_profile',
   'expectation_basis','recorded_model_prediction','human_confirmation',false))
 ON CONFLICT(workspace_id,user_id,fingerprint) DO UPDATE SET last_seen_at=now(),revision=issues.revision+1
 RETURNING * INTO recorded;
 INSERT INTO issue_occurrences(action_id,run_id,issue_id,workspace_id) VALUES(action.action_id,action.run_id,recorded.issue_id,source.workspace_id);
 INSERT INTO issue_events(issue_id,workspace_id,seq,event_type,payload) VALUES(recorded.issue_id,source.workspace_id,recorded.revision,
 CASE WHEN recorded.source_action_id=action.action_id THEN 'issue.discovered' ELSE 'issue.observed_again' END,
 jsonb_build_object('run_id',action.run_id,'action_id',action.action_id,'issue_id',recorded.issue_id));
END $$;
CREATE OR REPLACE FUNCTION scout_issue_from_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM scout_record_issue(NEW); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS scout_issue_assessed ON runtime_actions;
CREATE TRIGGER scout_issue_assessed AFTER INSERT OR UPDATE OF state,assessment ON runtime_actions FOR EACH ROW EXECUTE FUNCTION scout_issue_from_action();
-- Existing evidence acquires identity without replay, inference or rewrites.
DO $$ DECLARE action runtime_actions; BEGIN
 FOR action IN SELECT a.* FROM runtime_actions a JOIN runtime_runs r USING(run_id)
 WHERE a.state='completed' AND a.assessment->>'verdict'='suspect' AND a.spec->'prediction'->>'source'='model'
 AND NOT EXISTS(SELECT 1 FROM issue_occurrences o WHERE o.action_id=a.action_id) ORDER BY r.created_at,a.ordinal
 LOOP PERFORM scout_record_issue(action); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION scout_verification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version bigint;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.status,NEW.outcome,NEW.run_id,NEW.result) IS NOT DISTINCT FROM (OLD.status,OLD.outcome,OLD.run_id,OLD.result) THEN RETURN NEW; END IF;
 UPDATE issues SET revision=revision+1 WHERE issue_id=NEW.issue_id AND workspace_id=NEW.workspace_id RETURNING revision INTO version;
 INSERT INTO issue_events(issue_id,workspace_id,seq,event_type,payload) VALUES(NEW.issue_id,NEW.workspace_id,version,
 CASE WHEN NEW.outcome IS NOT NULL THEN 'verification.finished' WHEN NEW.status='running' THEN 'verification.started' ELSE 'verification.queued' END,
 jsonb_build_object('verification_id',NEW.verification_id,'job_id',NEW.job_id,'run_id',NEW.run_id,'outcome',NEW.outcome,'candidate_url',NEW.candidate_url,'deployment_ref',NEW.deployment_ref));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scout_verification_history ON issue_verifications;
CREATE TRIGGER scout_verification_history AFTER INSERT OR UPDATE ON issue_verifications FOR EACH ROW EXECUTE FUNCTION scout_verification_event();
CREATE OR REPLACE FUNCTION scout_verification_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.request->>'kind'<>'verify_fix' THEN RETURN NEW; END IF;
 IF NEW.status IN ('queued','running') THEN
   UPDATE issue_verifications SET status=NEW.status,run_id=NEW.run_id WHERE job_id=NEW.job_id AND workspace_id=NEW.workspace_id AND outcome IS NULL;
 ELSE
   UPDATE issue_verifications SET status='completed',run_id=NEW.run_id,outcome=CASE WHEN NEW.status='blocked' THEN 'blocked' ELSE 'inconclusive' END,
    result=jsonb_build_object('outcome',CASE WHEN NEW.status='blocked' THEN 'blocked' ELSE 'inconclusive' END,
      'reason',CASE WHEN NEW.status='cancelled' THEN 'Verification was cancelled. This does not establish that the issue was fixed.' WHEN NEW.status='blocked' THEN 'Access or policy prevented the recorded behavior from being checked.' ELSE 'Verification did not establish the expected behavior. Inspect execution and evidence.' END,
      'job_status',NEW.status,'coverage_complete',false,'verified_fixed_globally',false),finished_at=now()
   WHERE job_id=NEW.job_id AND workspace_id=NEW.workspace_id AND outcome IS NULL;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scout_verification_job_state ON browser_jobs;
CREATE TRIGGER scout_verification_job_state AFTER UPDATE OF status,run_id ON browser_jobs FOR EACH ROW EXECUTE FUNCTION scout_verification_job();

CREATE OR REPLACE FUNCTION scout_issue_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occurrence issue_occurrences; version bigint;
BEGIN
 SELECT * INTO occurrence FROM issue_occurrences WHERE action_id=NEW.action_id AND workspace_id=NEW.workspace_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 UPDATE issues SET revision=revision+1 WHERE issue_id=occurrence.issue_id RETURNING revision INTO version;
 INSERT INTO issue_events(issue_id,workspace_id,seq,event_type,payload) VALUES(occurrence.issue_id,occurrence.workspace_id,version,'issue.reviewed',
 jsonb_build_object('action_id',NEW.action_id,'review_id',NEW.review_id,'disposition',NEW.disposition,'review_revision',NEW.revision));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scout_issue_review_history ON finding_reviews;
CREATE TRIGGER scout_issue_review_history AFTER INSERT ON finding_reviews FOR EACH ROW EXECUTE FUNCTION scout_issue_review();

CREATE OR REPLACE FUNCTION scout_run_usage(id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('run_id',id,'attempts',count(*),'known_input_tokens',sum(c.input_tokens),'known_output_tokens',sum(c.output_tokens),
 'incomplete_usage_attempts',count(*) FILTER(WHERE c.usage_status<>'reported'),'provider_reported_cost_usd',sum(c.cost_usd)::text,
 'unpriced_attempts',count(*) FILTER(WHERE c.cost_usd IS NULL),'pending_requests',(SELECT count(*) FROM model_requests WHERE run_id=id AND state IN ('queued','preparing','dispatched')))
 FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=id
$$;
CREATE OR REPLACE FUNCTION scout_verification_summary(v issue_verifications) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT (to_jsonb(v)-'source_snapshot'-'user_id') || jsonb_build_object('usage',scout_run_usage(v.run_id),'job_status',(SELECT status FROM browser_jobs WHERE job_id=v.job_id))
$$;
CREATE OR REPLACE FUNCTION scout_issue_summary(i issues) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT (to_jsonb(i)-'fingerprint'-'snapshot'-'user_id') || jsonb_build_object('title',i.snapshot->>'title','expected_result',left(i.snapshot->>'expected_result',300),
 'observed_result',left(i.snapshot->>'observed_result',300),'viewport_profile',i.snapshot->>'viewport_profile',
 'occurrence_count',(SELECT count(*) FROM issue_occurrences WHERE issue_id=i.issue_id),
 'latest_verification',(SELECT scout_verification_summary(v)-'result' FROM issue_verifications v WHERE v.issue_id=i.issue_id ORDER BY v.created_at DESC,v.verification_id DESC LIMIT 1),
 'human_review',(SELECT jsonb_build_object('disposition',disposition,'revision',revision) FROM finding_reviews WHERE action_id=i.source_action_id ORDER BY revision DESC LIMIT 1))
$$;
