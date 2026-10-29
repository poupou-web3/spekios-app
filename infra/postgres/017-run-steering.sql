-- Focus changes are serialized with action admission, cancellation and run
-- finalization on runtime_runs. The event outbox also exports these to ClickHouse.
CREATE TABLE IF NOT EXISTS run_steering (
  steering_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  agent_id uuid,
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 32),
  focus text NOT NULL CHECK(char_length(focus)<=2000),
  status text NOT NULL CHECK(status IN ('pending','applied','superseded','not_applied')),
  reason text,
  decision_id uuid REFERENCES exploration_decisions(decision_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE(run_id,revision),
  CHECK((status='applied')=(decision_id IS NOT NULL)),
  CHECK((status='pending')=(acknowledged_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS run_steering_pending ON run_steering(run_id) WHERE status='pending';

CREATE OR REPLACE FUNCTION scout_steering_snapshot(id uuid,page_offset integer,page_limit integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('run_id',id,'revision',COALESCE((SELECT max(revision) FROM run_steering WHERE run_id=id),0),
   'active_focus',(SELECT to_jsonb(a) FROM run_steering a WHERE run_id=id AND status='applied' ORDER BY revision DESC LIMIT 1),
   'messages',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY revision) FROM
     (SELECT * FROM run_steering WHERE run_id=id ORDER BY revision DESC LIMIT page_limit OFFSET page_offset) s),'[]'::jsonb),
   'has_more',(SELECT count(*)>page_offset+page_limit FROM run_steering WHERE run_id=id),
   'next_offset',CASE WHEN (SELECT count(*)>page_offset+page_limit FROM run_steering WHERE run_id=id) THEN page_offset+page_limit END,
   'offset',page_offset,'limit',page_limit,'history_order','newest_page_first_chronological_within_page',
   'application_boundary','next_planning_decision','max_messages',32)
$$;
CREATE OR REPLACE FUNCTION scout_steering_snapshot(id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT scout_steering_snapshot(id,0,8)
$$;

CREATE OR REPLACE FUNCTION scout_steering_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version bigint;
BEGIN
 UPDATE runtime_runs SET event_seq=event_seq+1 WHERE run_id=NEW.run_id RETURNING event_seq INTO version;
 INSERT INTO runtime_events(event_id,run_id,seq,event_type,payload)
 VALUES(gen_random_uuid(),NEW.run_id,version,'steering.'||NEW.status,to_jsonb(NEW));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scout_steering_history ON run_steering;
CREATE TRIGGER scout_steering_history AFTER INSERT OR UPDATE OF status ON run_steering FOR EACH ROW EXECUTE FUNCTION scout_steering_event();

CREATE OR REPLACE FUNCTION scout_steering_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.lifecycle<>'active' OR NEW.cancel_id IS NOT NULL THEN
   UPDATE run_steering SET status='not_applied',acknowledged_at=now(),
    reason=CASE WHEN NEW.cancel_id IS NOT NULL THEN 'cancelled_before_next_plan' ELSE 'run_ended_before_next_plan' END
   WHERE run_id=NEW.run_id AND status='pending';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scout_steering_run_finished ON runtime_runs;
CREATE TRIGGER scout_steering_run_finished AFTER UPDATE OF lifecycle,cancel_id ON runtime_runs FOR EACH ROW EXECUTE FUNCTION scout_steering_finish();

CREATE OR REPLACE FUNCTION scout_submit_steering(id uuid,workspace uuid,owner uuid,agent uuid,command uuid,expected integer,instruction text)
 RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run runtime_runs; saved run_steering; version integer; ended boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('scout-steering:'||command::text,0));
 SELECT * INTO run FROM runtime_runs WHERE run_id=id AND workspace_id=workspace AND user_id=owner FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','run_not_found'); END IF;
 SELECT * INTO saved FROM run_steering WHERE steering_id=command;
 IF FOUND THEN
   IF saved.run_id<>id OR saved.workspace_id<>workspace OR saved.user_id<>owner OR saved.agent_id IS DISTINCT FROM agent OR saved.revision<>expected+1 OR saved.focus<>instruction THEN
     RETURN jsonb_build_object('error','steering_id_conflict');
   END IF;
   RETURN scout_steering_snapshot(id)||jsonb_build_object('submission',to_jsonb(saved),'reused',true);
 END IF;
 IF run.config->>'runtime_version' IS DISTINCT FROM 'explorer-v1' OR run.config->'replay_of' IS DISTINCT FROM 'null'::jsonb THEN
   RETURN jsonb_build_object('error','steering_requires_exploration');
 END IF;
 SELECT COALESCE(max(revision),0) INTO version FROM run_steering WHERE run_id=id;
 IF expected<>version THEN RETURN jsonb_build_object('error','steering_revision_conflict','revision',version); END IF;
 IF version>=32 THEN RETURN jsonb_build_object('error','steering_limit_reached'); END IF;
 ended=run.lifecycle<>'active' OR run.cancel_id IS NOT NULL;
 UPDATE run_steering SET status='superseded',reason='replaced_before_next_plan',acknowledged_at=now() WHERE run_id=id AND status='pending';
 INSERT INTO run_steering(steering_id,run_id,workspace_id,user_id,agent_id,revision,focus,status,reason,acknowledged_at)
 VALUES(command,id,workspace,owner,agent,version+1,instruction,CASE WHEN ended THEN 'not_applied' ELSE 'pending' END,
   CASE WHEN ended THEN 'run_ended_before_submission' END,CASE WHEN ended THEN now() END) RETURNING * INTO saved;
 RETURN scout_steering_snapshot(id)||jsonb_build_object('submission',to_jsonb(saved),'reused',false);
END $$;
