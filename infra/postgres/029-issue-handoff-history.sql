BEGIN;

-- Match repeated observed behavior independently of the exploration path or
-- model's goal/reason wording. Different failures on one control remain separate.
-- Existing issue IDs, original evidence, reviews and events are never rewritten.
CREATE OR REPLACE FUNCTION scout_issue_signature(action runtime_actions) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
   'version',2,'page',b.page_url,'command',b.command,
   'viewport_profile',b.viewport_profile,'viewport',r.config->'viewport',
   'project_id',r.config->'project_id','execution_mode',r.config->'execution_mode',
   'signed_in',b.signed_in,'auth_reference',CASE WHEN b.signed_in THEN COALESCE((
     SELECT context->>'session_id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.config->'auth_contexts')='array' THEN r.config->'auth_contexts' ELSE '[]'::jsonb END) context
     WHERE context->>'context_id'=action.spec->>'auth_context_id' LIMIT 1),action.spec->>'auth_context_id') END,
   'expected',regexp_replace(lower(btrim(action.spec->'prediction'->>'expected_result')),'[[:space:]]+',' ','g'),
   'observed',regexp_replace(lower(btrim(COALESCE(action.assessment->>'observed_result',action.assessment->>'actual',''))),'[[:space:]]+',' ','g'),
   'missing_observation_action_id',CASE WHEN NULLIF(btrim(COALESCE(action.assessment->>'observed_result',action.assessment->>'actual','')),'') IS NULL THEN action.action_id END
 )::text,'UTF8')),'hex') FROM runtime_runs r CROSS JOIN LATERAL scout_behavior(action) b WHERE r.run_id=action.run_id
$$;
CREATE TABLE IF NOT EXISTS issue_signatures (
 workspace_id uuid NOT NULL,
 user_id uuid NOT NULL,
 signature text NOT NULL CHECK(signature ~ '^[0-9a-f]{64}$'),
 issue_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,user_id,signature),
 FOREIGN KEY(issue_id,workspace_id) REFERENCES issues(issue_id,workspace_id)
);
CREATE OR REPLACE FUNCTION scout_preserve_issue_signature() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Issue signature aliases are append-only'; END $$;
DROP TRIGGER IF EXISTS issue_signatures_append_only ON issue_signatures;
CREATE TRIGGER issue_signatures_append_only BEFORE UPDATE OR DELETE ON issue_signatures FOR EACH ROW EXECUTE FUNCTION scout_preserve_issue_signature();

-- Earliest original evidence owns a signature. Other historical IDs remain
-- accessible and appear as related findings instead of being silently merged.
INSERT INTO issue_signatures(workspace_id,user_id,signature,issue_id)
 SELECT i.workspace_id,i.user_id,scout_issue_signature(a),i.issue_id
 FROM issues i JOIN runtime_actions a ON a.run_id=i.source_run_id AND a.action_id=i.source_action_id
 ORDER BY i.first_seen_at,i.issue_id ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION scout_record_issue(action runtime_actions) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source runtime_runs; identity_key text; recorded issues; behavior record;
BEGIN
 IF action.state<>'completed' OR action.assessment->>'verdict' IS DISTINCT FROM 'suspect'
    OR action.assessment->'expectation_uncertain' IS DISTINCT FROM 'false'::jsonb
    OR action.tool_error IS NOT NULL OR action.spec->'prediction'->>'source' IS DISTINCT FROM 'model'
    OR EXISTS(SELECT 1 FROM issue_occurrences WHERE action_id=action.action_id) THEN RETURN; END IF;
 SELECT * INTO source FROM runtime_runs WHERE run_id=action.run_id;
 IF source.config->>'runtime_version' IS DISTINCT FROM 'explorer-v1' OR source.config->>'replay_of' IS NOT NULL OR source.config->>'fix_verification' IS NOT NULL THEN RETURN; END IF;
 IF NULLIF(btrim(action.spec->'prediction'->>'expected_result'),'') IS NULL OR action.before_capture_id IS NULL OR action.after_capture_id IS NULL THEN RETURN; END IF;
 identity_key=scout_issue_signature(action);
 PERFORM pg_advisory_xact_lock(hashtextextended(source.workspace_id::text||source.user_id::text||identity_key,2901));
 IF EXISTS(SELECT 1 FROM issue_occurrences WHERE action_id=action.action_id) THEN RETURN; END IF;
 SELECT i.* INTO recorded FROM issue_signatures s JOIN issues i USING(issue_id,workspace_id)
 WHERE s.workspace_id=source.workspace_id AND s.user_id=source.user_id AND s.signature=identity_key AND i.user_id=source.user_id FOR UPDATE OF i;
 IF FOUND THEN
   UPDATE issues SET last_seen_at=now(),revision=revision+1 WHERE issue_id=recorded.issue_id RETURNING * INTO recorded;
 ELSE
   INSERT INTO issues(workspace_id,user_id,fingerprint,source_run_id,source_action_id,source_target_url,snapshot)
   VALUES(source.workspace_id,source.user_id,identity_key,action.run_id,action.action_id,source.target_url,jsonb_build_object(
     'title',left(COALESCE(action.spec->'prediction'->>'goal','Recorded behavior mismatch'),300),
     'expected_result',action.spec->'prediction'->>'expected_result','observed_result',COALESCE(action.assessment->>'observed_result',action.assessment->>'actual'),
     'reason',action.assessment->>'reason','command',action.spec->'command','prediction_id',action.prediction_id,
     'before_capture_id',action.before_capture_id,'after_capture_id',action.after_capture_id,'viewport_profile',source.config->>'viewport_profile',
     'expectation_basis','recorded_model_prediction','human_confirmation',false,'matching_version',2))
   ON CONFLICT(workspace_id,user_id,fingerprint) DO UPDATE SET last_seen_at=now(),revision=issues.revision+1 RETURNING * INTO recorded;
   INSERT INTO issue_signatures(workspace_id,user_id,signature,issue_id) VALUES(source.workspace_id,source.user_id,identity_key,recorded.issue_id) ON CONFLICT DO NOTHING;
 END IF;
 INSERT INTO issue_occurrences(action_id,run_id,issue_id,workspace_id) VALUES(action.action_id,action.run_id,recorded.issue_id,source.workspace_id);
 INSERT INTO issue_events(issue_id,workspace_id,seq,event_type,payload) VALUES(recorded.issue_id,source.workspace_id,recorded.revision,
   CASE WHEN recorded.source_action_id=action.action_id THEN 'issue.discovered' ELSE 'issue.observed_again' END,
   jsonb_build_object('run_id',action.run_id,'action_id',action.action_id,'issue_id',recorded.issue_id,'matching_version',2));
 SELECT * INTO behavior FROM scout_behavior(action);
 INSERT INTO issue_behaviors(issue_id,workspace_id,user_id,behavior_key,page_url,command,viewport_profile,signed_in)
 VALUES(recorded.issue_id,source.workspace_id,source.user_id,behavior.behavior_key,behavior.page_url,behavior.command,behavior.viewport_profile,behavior.signed_in) ON CONFLICT DO NOTHING;
 -- A different failure on a reviewed control is a new finding. Existing human
 -- triage follows a matched issue; it is not copied to an unmatched failure.
END $$;

CREATE OR REPLACE FUNCTION scout_issue_tracking(id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH observed AS (SELECT count(*) AS occurrences,max(created_at) AS last_seen FROM issue_occurrences WHERE issue_id=id),
 checked AS (SELECT * FROM issue_verifications WHERE issue_id=id ORDER BY created_at DESC,verification_id DESC LIMIT 1)
 SELECT jsonb_build_object('status',CASE
   WHEN c.status IN ('queued','running') THEN 'checking'
   WHEN c.finished_at IS NOT NULL AND o.last_seen>c.finished_at THEN 'observed_again'
   WHEN c.outcome='resolved' THEN 'verified_on_candidate'
   WHEN c.outcome IS NOT NULL THEN c.outcome
   WHEN o.occurrences>1 THEN 'observed_again' ELSE 'new' END,
 'occurrence_count',o.occurrences,'last_observed_at',o.last_seen,
 'last_checked_at',c.finished_at,'latest_verification_id',c.verification_id,'latest_verification_outcome',c.outcome,
 'candidate_url',c.candidate_url,'deployment_ref',c.deployment_ref,
 'global_fix_claim',false,'absence_in_a_run_means_fixed',false)
 FROM observed o LEFT JOIN checked c ON true
$$;

CREATE OR REPLACE FUNCTION scout_issue_summary(i issues) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT (to_jsonb(i)-'fingerprint'-'snapshot'-'user_id') || jsonb_build_object('title',i.snapshot->>'title','expected_result',left(i.snapshot->>'expected_result',300),
 'observed_result',left(i.snapshot->>'observed_result',300),'viewport_profile',i.snapshot->>'viewport_profile',
 'occurrence_count',(SELECT count(*) FROM issue_occurrences WHERE issue_id=i.issue_id),
 'latest_verification',(SELECT scout_verification_summary(v)-'result' FROM issue_verifications v WHERE v.issue_id=i.issue_id ORDER BY v.created_at DESC,v.verification_id DESC LIMIT 1),
 'human_review',(SELECT jsonb_build_object('disposition',disposition,'revision',revision) FROM finding_reviews WHERE action_id=i.source_action_id ORDER BY revision DESC LIMIT 1),
 'triage',scout_issue_triage(i.issue_id),
 'triage_status',COALESCE((SELECT decision FROM issue_triage WHERE issue_id=i.issue_id ORDER BY revision DESC LIMIT 1),'untriaged'),
 'canonical_issue_id',scout_canonical_issue(i.issue_id),
 'page_url',(SELECT page_url FROM issue_behaviors WHERE issue_id=i.issue_id),'tracking',scout_issue_tracking(i.issue_id))
$$;

COMMIT;
