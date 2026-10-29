//! Workspace-scoped stored run and evidence projections.
use crate::{AppState, error, identity::ScopedState, query};
use axum::{
    Json,
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use uuid::Uuid;

pub async fn list(ScopedState(state): ScopedState) -> Response {
    let sql = "SELECT jsonb_build_object('runs',COALESCE(jsonb_agg(to_jsonb(r)||jsonb_build_object('summary',(
        SELECT jsonb_build_object('actions',count(*),
          'candidates',count(*) FILTER (WHERE a.assessment->>'verdict'='suspect' AND r.config->>'runtime_version'='explorer-v1' AND r.config->'replay_of'='null'::jsonb),
          'pending_findings',count(*) FILTER (WHERE a.assessment->>'verdict'='suspect' AND r.config->>'runtime_version'='explorer-v1' AND r.config->'replay_of'='null'::jsonb AND COALESCE(v.disposition,'needs_review')='needs_review'),
          'confirmed_findings',count(*) FILTER (WHERE a.assessment->>'verdict'='suspect' AND r.config->'replay_of'='null'::jsonb AND v.disposition='confirmed'),
          'dismissed_findings',count(*) FILTER (WHERE a.assessment->>'verdict'='suspect' AND r.config->'replay_of'='null'::jsonb AND v.disposition='dismissed'))
        FROM runtime_actions a LEFT JOIN LATERAL (
          SELECT disposition FROM finding_reviews f WHERE f.action_id=a.action_id AND f.workspace_id=$1 AND f.user_id=$2 ORDER BY revision DESC LIMIT 1
        ) v ON true WHERE a.run_id=r.run_id
      )) ORDER BY r.created_at DESC,r.run_id),'[]'::jsonb))
      FROM (SELECT run_id,target_url,lifecycle,config,created_at,finished_at,error,cancel_id,cancel_requested_at
            FROM runtime_runs WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC,run_id LIMIT 50) r";
    match query(
        &state,
        sql,
        &[&state.principal.workspace_id, &state.principal.user_id],
    )
    .await
    {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => Json(json!({"runs":[]})).into_response(),
        Err(response) => response,
    }
}

pub async fn get(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    match load(&state, id).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

pub(crate) async fn load(state: &AppState, id: Uuid) -> Result<Value, Response> {
    // One SQL statement gives a consistent database snapshot of all relationships.
    let sql = "SELECT jsonb_build_object('schema_version',1,'run',to_jsonb(r),
      'actions',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.ordinal) FROM runtime_actions a WHERE a.run_id=r.run_id),'[]'::jsonb),
      'captures',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at,c.capture_id) FROM runtime_captures c WHERE c.run_id=r.run_id),'[]'::jsonb),
      'artifacts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.artifact_id) FROM runtime_artifacts a WHERE a.run_id=r.run_id),'[]'::jsonb),
      'steering',scout_steering_snapshot(r.run_id,0,32),
      'events',COALESCE((SELECT jsonb_agg(to_jsonb(e)-'exported_at' ORDER BY e.seq) FROM runtime_events e WHERE e.run_id=r.run_id),'[]'::jsonb),
      'graph',(SELECT graph FROM exploration_graphs WHERE run_id=r.run_id),
      'persistent_issues',COALESCE((SELECT jsonb_agg(to_jsonb(o)||jsonb_build_object('title',i.snapshot->>'title')) FROM issue_occurrences o JOIN issues i USING(issue_id,workspace_id) WHERE o.run_id=r.run_id AND o.workspace_id=r.workspace_id),'[]'::jsonb),
      'fix_verification',(SELECT scout_verification_summary(v) FROM issue_verifications v WHERE v.run_id=r.run_id AND v.workspace_id=r.workspace_id),
      'reproductions',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at,v.reproduction_id) FROM runtime_reproductions v WHERE v.source_run_id=r.run_id OR v.replay_run_id=r.run_id),'[]'::jsonb),
      'automatic_reproductions',COALESCE((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('child_job',CASE WHEN j.job_id IS NULL THEN NULL ELSE jsonb_build_object('job_id',j.job_id,'status',j.status,'run_id',j.run_id,'error',j.error,'cancel_id',j.cancel_id,'cancel_requested_at',j.cancel_requested_at,'parent_job_id',j.parent_job_id) END,'reproduction',(SELECT to_jsonb(v) FROM runtime_reproductions v WHERE v.source_action_id=t.source_action_id AND v.source_run_id=t.source_run_id)) ORDER BY t.created_at,t.task_id) FROM automatic_reproduction_tasks t JOIN browser_jobs p ON p.job_id=t.source_job_id AND p.run_id=t.source_run_id JOIN runtime_runs s ON s.run_id=t.source_run_id LEFT JOIN browser_jobs j ON j.job_id=t.child_job_id AND j.parent_job_id=p.job_id AND j.automatic_source_action_id=t.source_action_id AND j.workspace_id=r.workspace_id AND j.user_id=r.user_id WHERE (t.source_run_id=r.run_id OR j.run_id=r.run_id) AND p.workspace_id=r.workspace_id AND p.user_id=r.user_id AND s.workspace_id=r.workspace_id AND s.user_id=r.user_id),'[]'::jsonb),
      'finding_reviews',COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.created_at,f.review_id) FROM finding_reviews f WHERE f.workspace_id=r.workspace_id AND f.user_id=r.user_id AND (f.run_id=r.run_id OR f.action_id IN (SELECT source_action_id FROM runtime_reproductions WHERE replay_run_id=r.run_id))),'[]'::jsonb),
      'model_requests',COALESCE((SELECT jsonb_agg(to_jsonb(mr)-'spec' ORDER BY mr.created_at,mr.request_id) FROM model_requests mr WHERE mr.run_id=r.run_id),'[]'::jsonb),
      'model_calls',COALESCE((SELECT jsonb_agg(jsonb_build_object('call_id',c.call_id,'request_id',c.request_id,'attempt',c.attempt,'state',c.state,'started_at',c.started_at,'finished_at',c.finished_at,'elapsed_ms',c.elapsed_ms,'http_status',c.http_status,'input_tokens',c.input_tokens,'output_tokens',c.output_tokens,'cached_input_tokens',c.cached_input_tokens,'cache_write_tokens',c.cache_write_tokens,'reasoning_tokens',c.reasoning_tokens,'usage_status',c.usage_status,'cost_usd',c.cost_usd::text,'returned_model',c.returned_model,'routed_provider',c.routed_provider,'error',c.error) ORDER BY c.started_at,c.call_id) FROM model_calls c JOIN model_requests mr USING(request_id) WHERE mr.run_id=r.run_id AND mr.workspace_id=r.workspace_id AND mr.user_id=r.user_id),'[]'::jsonb),
      'model_usage',(SELECT jsonb_build_object('attempts',count(*),'known_input_tokens',sum(c.input_tokens),'known_output_tokens',sum(c.output_tokens),'incomplete_usage_attempts',count(*) FILTER (WHERE c.usage_status<>'reported'),'pending_requests',(SELECT count(*) FROM model_requests WHERE run_id=r.run_id AND state IN ('queued','preparing','dispatched')),'provider_reported_cost_usd',sum(c.cost_usd)::text,'unpriced_attempts',count(*) FILTER (WHERE c.cost_usd IS NULL)) FROM model_calls c JOIN model_requests mr USING(request_id) WHERE mr.run_id=r.run_id))
      FROM runtime_runs r WHERE r.run_id=$1 AND r.workspace_id=$2 AND r.user_id=$3";
    match query(
        state,
        sql,
        &[&id, &state.principal.workspace_id, &state.principal.user_id],
    )
    .await
    {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err(error(StatusCode::NOT_FOUND, "run_not_found")),
        Err(response) => Err(response),
    }
}

pub async fn graph(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    match query(
        &state,
        "SELECT graph FROM exploration_graphs WHERE run_id=$1 AND workspace_id=$2",
        &[&id, &state.principal.workspace_id],
    )
    .await
    {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "exploration_not_found"),
        Err(response) => response,
    }
}

pub async fn capture(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    match query(&state, "SELECT to_jsonb(c) FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE c.capture_id=$1 AND r.workspace_id=$2", &[&id, &state.principal.workspace_id]).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "capture_not_found"),
        Err(response) => response,
    }
}
