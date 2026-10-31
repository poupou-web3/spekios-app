-- Triage turns a recorded suspicion into a decision: a bug to keep checking,
-- intended behavior that later runs recognize, or a duplicate of another
-- issue. Decisions are append-only and attributed to a person, an agent or
-- Scout itself. Evidence, model assessments and human reviews are unchanged.

-- Scroll position and layout are not part of what a control does. Without
-- this, one bug reached at two scroll positions became two issues.
CREATE OR REPLACE FUNCTION scout_command_identity(command jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT (command-'control') || CASE WHEN command ? 'control' THEN jsonb_build_object('control',
   (command->'control')-'control_id'-'rect'-'occluded'-'in_viewport'-'page_y'-'ambiguous') ELSE '{}'::jsonb END
$$;

-- What a later run recognizes as the same behavior, whatever path reached it:
-- the page the action started on, what was done there, the viewport and
-- whether it happened signed in. The issue fingerprint still keeps the path.
CREATE TABLE IF NOT EXISTS issue_behaviors (
  issue_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  behavior_key text NOT NULL CHECK (behavior_key ~ '^[0-9a-f]{64}$'),
  page_url text NOT NULL,
  command jsonb NOT NULL,
  viewport_profile text,
  signed_in boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (issue_id,workspace_id) REFERENCES issues(issue_id,workspace_id)
);
CREATE INDEX IF NOT EXISTS issue_behaviors_key ON issue_behaviors(workspace_id,user_id,behavior_key);

CREATE OR REPLACE FUNCTION scout_behavior(action runtime_actions) RETURNS TABLE(behavior_key text,page_url text,command jsonb,viewport_profile text,signed_in boolean)
LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('page',b.page_url,'command',b.command,'viewport',b.viewport_profile,'signed_in',b.signed_in)::text,'UTF8')),'hex'),
   b.page_url,b.command,b.viewport_profile,b.signed_in
 FROM (SELECT regexp_replace(COALESCE(c.observation->>'url',r.target_url),'#.*$','') AS page_url,scout_command_identity(action.spec->'command') AS command,
   r.config->>'viewport_profile' AS viewport_profile,action.spec->>'auth_context_id' IS NOT NULL AS signed_in
   FROM runtime_runs r LEFT JOIN runtime_captures c ON c.capture_id=action.before_capture_id WHERE r.run_id=action.run_id) b
$$;

CREATE TABLE IF NOT EXISTS issue_triage (
  triage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  decision text NOT NULL CHECK (decision IN ('bug','intended_behavior','duplicate','needs_review')),
  duplicate_of uuid,
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) BETWEEN 1 AND 2000),
  actor text NOT NULL CHECK (actor IN ('human','agent','system')),
  agent_id uuid,
  -- Scout's own decisions name the triaged issue whose behavior they matched.
  matched_issue_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id,revision),
  FOREIGN KEY (issue_id,workspace_id) REFERENCES issues(issue_id,workspace_id),
  FOREIGN KEY (duplicate_of,workspace_id) REFERENCES issues(issue_id,workspace_id),
  CHECK ((decision='duplicate')=(duplicate_of IS NOT NULL)),
  CHECK (duplicate_of IS DISTINCT FROM issue_id),
  CHECK ((actor='system')=(matched_issue_id IS NOT NULL)),
  CHECK (actor='agent' OR agent_id IS NULL)
);
CREATE INDEX IF NOT EXISTS issue_triage_latest ON issue_triage(issue_id,revision DESC);
CREATE INDEX IF NOT EXISTS issue_triage_duplicates ON issue_triage(duplicate_of) WHERE duplicate_of IS NOT NULL;

CREATE OR REPLACE FUNCTION scout_reject_triage_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Issue triage history is append-only'; END $$;
DROP TRIGGER IF EXISTS issue_triage_append_only ON issue_triage;
CREATE TRIGGER issue_triage_append_only BEFORE UPDATE OR DELETE ON issue_triage FOR EACH ROW EXECUTE FUNCTION scout_reject_triage_change();

CREATE OR REPLACE FUNCTION scout_issue_triaged() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version bigint;
BEGIN
 UPDATE issues SET revision=revision+1 WHERE issue_id=NEW.issue_id AND workspace_id=NEW.workspace_id RETURNING revision INTO version;
 INSERT INTO issue_events(issue_id,workspace_id,seq,event_type,payload) VALUES(NEW.issue_id,NEW.workspace_id,version,'issue.triaged',
   jsonb_build_object('triage_id',NEW.triage_id,'triage_revision',NEW.revision,'decision',NEW.decision,'duplicate_of',NEW.duplicate_of,
     'actor',NEW.actor,'agent_id',NEW.agent_id,'matched_issue_id',NEW.matched_issue_id));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS issue_triage_history ON issue_triage;
CREATE TRIGGER issue_triage_history AFTER INSERT ON issue_triage FOR EACH ROW EXECUTE FUNCTION scout_issue_triaged();

CREATE OR REPLACE FUNCTION scout_issue_triage(id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT to_jsonb(t)-'workspace_id'-'user_id' FROM issue_triage t WHERE issue_id=id ORDER BY revision DESC LIMIT 1
$$;
-- A duplicate points at its canonical issue; follow a chain left behind when
-- that canonical issue was itself marked a duplicate later. Bounded, cycle-safe.
CREATE OR REPLACE FUNCTION scout_canonical_issue(id uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE current uuid := id; next uuid; steps integer := 0;
BEGIN
 LOOP
   SELECT CASE WHEN decision='duplicate' THEN duplicate_of END INTO next FROM issue_triage WHERE issue_id=current ORDER BY revision DESC LIMIT 1;
   IF next IS NULL OR next=id OR steps>=16 THEN RETURN current; END IF;
   current := next; steps := steps+1;
 END LOOP;
END $$;

-- The one write path for API, agent and Scout decisions. An agent or Scout
-- never replaces a person's decision; a person can replace anything.
CREATE OR REPLACE FUNCTION scout_triage_issue(id uuid,workspace uuid,owner uuid,who text,agent uuid,choice text,target uuid,why text,expected integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE current issue_triage; canonical uuid; recorded issue_triage;
BEGIN
 PERFORM 1 FROM issues WHERE issue_id=id AND workspace_id=workspace AND user_id=owner FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','issue_not_found'); END IF;
 SELECT * INTO current FROM issue_triage WHERE issue_id=id ORDER BY revision DESC LIMIT 1;
 IF choice='duplicate' THEN
   IF NOT EXISTS(SELECT 1 FROM issues WHERE issue_id=target AND workspace_id=workspace AND user_id=owner) THEN RETURN jsonb_build_object('error','duplicate_target_not_found'); END IF;
   canonical := scout_canonical_issue(target);
   IF canonical=id THEN RETURN jsonb_build_object('error','duplicate_cycle'); END IF;
 END IF;
 -- A retried identical decision is the same decision.
 IF current.triage_id IS NOT NULL AND current.decision=choice AND current.duplicate_of IS NOT DISTINCT FROM canonical
    AND current.rationale=btrim(why) AND current.actor=who AND current.agent_id IS NOT DISTINCT FROM agent THEN
   RETURN jsonb_build_object('triage',scout_issue_triage(id),'reused',true);
 END IF;
 IF expected IS NOT NULL AND COALESCE(current.revision,0)<>expected THEN
   RETURN jsonb_build_object('error','triage_revision_conflict','triage',scout_issue_triage(id));
 END IF;
 IF who<>'human' AND current.actor='human' THEN RETURN jsonb_build_object('error','human_decision_present','triage',scout_issue_triage(id)); END IF;
 INSERT INTO issue_triage(issue_id,workspace_id,user_id,revision,decision,duplicate_of,rationale,actor,agent_id)
 VALUES(id,workspace,owner,COALESCE(current.revision,0)+1,choice,canonical,btrim(why),who,CASE WHEN who='agent' THEN agent END) RETURNING * INTO recorded;
 RETURN jsonb_build_object('triage',to_jsonb(recorded)-'workspace_id'-'user_id','reused',false);
END $$;

-- Issue registration now records the behavior and, when a triaged issue has
-- the same behavior, triages the new issue the same way. Everything is still
-- recorded; known behavior is labelled, never dropped.
CREATE OR REPLACE FUNCTION scout_record_issue(action runtime_actions) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source runtime_runs; identity_key text; recorded issues; path_identity jsonb; behavior record; known record;
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
 IF recorded.source_action_id<>action.action_id THEN RETURN; END IF;
 SELECT * INTO behavior FROM scout_behavior(action);
 INSERT INTO issue_behaviors(issue_id,workspace_id,user_id,behavior_key,page_url,command,viewport_profile,signed_in)
 VALUES(recorded.issue_id,source.workspace_id,source.user_id,behavior.behavior_key,behavior.page_url,behavior.command,behavior.viewport_profile,behavior.signed_in);
 -- The newest decision about this behavior wins when several issues share it.
 SELECT b.issue_id,t.decision,t.created_at INTO known FROM issue_behaviors b
   JOIN LATERAL (SELECT decision,created_at FROM issue_triage WHERE issue_id=b.issue_id ORDER BY revision DESC LIMIT 1) t ON true
   WHERE b.workspace_id=source.workspace_id AND b.user_id=source.user_id AND b.behavior_key=behavior.behavior_key AND b.issue_id<>recorded.issue_id
     AND t.decision IN ('bug','intended_behavior','duplicate')
   ORDER BY t.created_at DESC,b.issue_id LIMIT 1;
 IF known.issue_id IS NULL THEN RETURN; END IF;
 INSERT INTO issue_triage(issue_id,workspace_id,user_id,revision,decision,duplicate_of,rationale,actor,matched_issue_id)
 VALUES(recorded.issue_id,source.workspace_id,source.user_id,1,
   CASE WHEN known.decision='intended_behavior' THEN 'intended_behavior' ELSE 'duplicate' END,
   CASE WHEN known.decision='intended_behavior' THEN NULL ELSE scout_canonical_issue(known.issue_id) END,
   CASE WHEN known.decision='intended_behavior' THEN 'Same page and control as an issue triaged as intended behavior.'
     ELSE 'Same page and control as a known issue.' END,
   'system',known.issue_id);
END $$;

-- Existing issues gain a behavior identity; no triage is invented for them.
INSERT INTO issue_behaviors(issue_id,workspace_id,user_id,behavior_key,page_url,command,viewport_profile,signed_in)
SELECT i.issue_id,i.workspace_id,i.user_id,b.behavior_key,b.page_url,b.command,b.viewport_profile,b.signed_in
FROM issues i JOIN runtime_actions a ON a.action_id=i.source_action_id AND a.run_id=i.source_run_id CROSS JOIN LATERAL scout_behavior(a) b
ON CONFLICT (issue_id) DO NOTHING;

CREATE OR REPLACE FUNCTION scout_issue_summary(i issues) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT (to_jsonb(i)-'fingerprint'-'snapshot'-'user_id') || jsonb_build_object('title',i.snapshot->>'title','expected_result',left(i.snapshot->>'expected_result',300),
 'observed_result',left(i.snapshot->>'observed_result',300),'viewport_profile',i.snapshot->>'viewport_profile',
 'occurrence_count',(SELECT count(*) FROM issue_occurrences WHERE issue_id=i.issue_id),
 'latest_verification',(SELECT scout_verification_summary(v)-'result' FROM issue_verifications v WHERE v.issue_id=i.issue_id ORDER BY v.created_at DESC,v.verification_id DESC LIMIT 1),
 'human_review',(SELECT jsonb_build_object('disposition',disposition,'revision',revision) FROM finding_reviews WHERE action_id=i.source_action_id ORDER BY revision DESC LIMIT 1),
 'triage',scout_issue_triage(i.issue_id),
 'triage_status',COALESCE((SELECT decision FROM issue_triage WHERE issue_id=i.issue_id ORDER BY revision DESC LIMIT 1),'untriaged'),
 'canonical_issue_id',scout_canonical_issue(i.issue_id),
 'page_url',(SELECT page_url FROM issue_behaviors WHERE issue_id=i.issue_id))
$$;

-- A recheck verifies a deployment against every open issue of one origin. Each
-- admitted issue is an ordinary fix verification with its own job and run.
CREATE TABLE IF NOT EXISTS issue_rechecks (
  recheck_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  user_id uuid NOT NULL,
  agent_id uuid,
  source_origin text NOT NULL CHECK (char_length(source_origin) BETWEEN 8 AND 512),
  candidate_origin text NOT NULL CHECK (char_length(candidate_origin) BETWEEN 8 AND 512),
  deployment_ref text CHECK (deployment_ref IS NULL OR char_length(deployment_ref) BETWEEN 1 AND 200),
  issue_ids uuid[] NOT NULL CHECK (cardinality(issue_ids) <= 25),
  omitted_issues integer NOT NULL DEFAULT 0 CHECK (omitted_issues >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_rechecks_recent ON issue_rechecks(workspace_id,user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS issue_recheck_items (
  recheck_id uuid NOT NULL REFERENCES issue_rechecks(recheck_id),
  issue_id uuid NOT NULL,
  verification_id uuid REFERENCES issue_verifications(verification_id),
  skipped_reason text CHECK (skipped_reason IS NULL OR char_length(skipped_reason) BETWEEN 1 AND 100),
  PRIMARY KEY (recheck_id,issue_id),
  CHECK ((verification_id IS NULL)<>(skipped_reason IS NULL))
);
CREATE OR REPLACE FUNCTION scout_reject_recheck_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Recheck records are append-only'; END $$;
DROP TRIGGER IF EXISTS issue_rechecks_append_only ON issue_rechecks;
CREATE TRIGGER issue_rechecks_append_only BEFORE UPDATE OR DELETE ON issue_rechecks FOR EACH ROW EXECUTE FUNCTION scout_reject_recheck_change();
DROP TRIGGER IF EXISTS issue_recheck_items_append_only ON issue_recheck_items;
CREATE TRIGGER issue_recheck_items_append_only BEFORE UPDATE OR DELETE ON issue_recheck_items FOR EACH ROW EXECUTE FUNCTION scout_reject_recheck_change();

CREATE OR REPLACE FUNCTION scout_recheck_summary(id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH items AS (
   SELECT ri.issue_id,ri.verification_id,ri.skipped_reason,i.snapshot->>'title' AS title,v.status,v.outcome,v.run_id,v.candidate_url
   FROM issue_recheck_items ri JOIN issues i ON i.issue_id=ri.issue_id LEFT JOIN issue_verifications v ON v.verification_id=ri.verification_id
   WHERE ri.recheck_id=id)
 SELECT (to_jsonb(r)-'user_id'-'workspace_id') || jsonb_build_object(
   'items',COALESCE((SELECT jsonb_agg(to_jsonb(items) ORDER BY title,issue_id) FROM items),'[]'::jsonb),
   'counts',jsonb_build_object('selected',cardinality(r.issue_ids),'admitted',(SELECT count(*) FROM items WHERE verification_id IS NOT NULL),
     'skipped',(SELECT count(*) FROM items WHERE skipped_reason IS NOT NULL),'pending',(SELECT count(*) FROM items WHERE verification_id IS NOT NULL AND outcome IS NULL),
     'resolved',(SELECT count(*) FROM items WHERE outcome='resolved'),'still_reproducible',(SELECT count(*) FROM items WHERE outcome='still_reproducible'),
     'blocked',(SELECT count(*) FROM items WHERE outcome='blocked'),'inconclusive',(SELECT count(*) FROM items WHERE outcome='inconclusive')),
   'complete',cardinality(r.issue_ids)=(SELECT count(*) FROM items) AND NOT EXISTS(SELECT 1 FROM items WHERE verification_id IS NOT NULL AND outcome IS NULL))
 FROM issue_rechecks r WHERE r.recheck_id=id
$$;
