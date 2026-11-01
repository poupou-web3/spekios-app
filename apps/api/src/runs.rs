//! Workspace-scoped stored run and evidence projections.
use crate::{AppState, error, identity::ScopedState, query};
use axum::{
    Json,
    extract::Path,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use uuid::Uuid;

/// Cheap fingerprint of the run document. Open workspace tabs send it back as
/// `If-None-Match` so an unchanged report is not rebuilt or transferred.
const SNAPSHOT_SQL: &str = "SELECT to_jsonb(md5(concat_ws('|'
  ,md5(to_jsonb(r)::text)
  ,coalesce((SELECT concat_ws(':', count(*), count(*) FILTER (WHERE state='completed'), count(*) FILTER (WHERE assessment->>'verdict'='suspect'), coalesce(max(finished_at)::text,'')) FROM runtime_actions a WHERE a.run_id=r.run_id),'')
  ,coalesce((SELECT concat_ws(':', count(*), count(*) FILTER (WHERE status='available'), count(*) FILTER (WHERE status='failed')) FROM runtime_captures c WHERE c.run_id=r.run_id),'')
  ,coalesce((SELECT concat_ws(':', count(*), count(*) FILTER (WHERE status='available')) FROM runtime_artifacts a WHERE a.run_id=r.run_id),'')
  ,coalesce((SELECT max(seq)::text FROM runtime_events e WHERE e.run_id=r.run_id),'')
  ,coalesce((SELECT count(*)::text FROM exploration_states s WHERE s.run_id=r.run_id),'')
  ,coalesce((SELECT count(*)::text FROM exploration_edges e WHERE e.run_id=r.run_id),'')
  ,coalesce((SELECT concat_ws(':', count(*), count(*) FILTER (WHERE status='unexplored'), count(*) FILTER (WHERE status='blocked')) FROM exploration_frontier f WHERE f.run_id=r.run_id),'')
  ,coalesce((SELECT concat_ws(':', count(*), count(*) FILTER (WHERE status='requested'), coalesce(max(finished_at)::text,'')) FROM exploration_decisions d WHERE d.run_id=r.run_id),'')
  ,coalesce((SELECT concat_ws(':', count(*), coalesce(max(created_at)::text,'')) FROM runtime_reproductions v WHERE v.source_run_id=r.run_id OR v.replay_run_id=r.run_id),'')
  ,coalesce((SELECT string_agg(t.status || ':' || coalesce(j.status,'') || ':' || coalesce(j.cancel_id::text,'') || ':' || coalesce(t.updated_at::text,''), ',' ORDER BY t.task_id) FROM automatic_reproduction_tasks t LEFT JOIN browser_jobs j ON j.job_id=t.child_job_id AND j.workspace_id=r.workspace_id AND j.user_id=r.user_id WHERE t.source_run_id=r.run_id),'')
  ,coalesce((SELECT concat_ws(':', count(*), coalesce(max(revision),0)) FROM finding_reviews f WHERE f.workspace_id=r.workspace_id AND f.user_id=r.user_id AND (f.run_id=r.run_id OR f.action_id IN (SELECT action_id FROM runtime_actions WHERE run_id=r.run_id))),'')
  ,coalesce((SELECT count(*)::text FROM issue_occurrences o WHERE o.run_id=r.run_id AND o.workspace_id=r.workspace_id),'')
  ,coalesce((SELECT v.status || ':' || coalesce(v.outcome,'') FROM issue_verifications v WHERE v.run_id=r.run_id AND v.workspace_id=r.workspace_id),'')
  ,coalesce((SELECT concat_ws(':', count(*), count(*) FILTER (WHERE state IN ('queued','preparing','dispatched')), coalesce(max(finished_at)::text,'')) FROM model_requests m WHERE m.run_id=r.run_id AND m.workspace_id=r.workspace_id AND m.user_id=r.user_id),'')
  ,coalesce((SELECT concat_ws(':', count(*), count(*) FILTER (WHERE c.state='completed'), coalesce(max(c.finished_at)::text,''), coalesce(sum(c.input_tokens),0), coalesce(sum(c.output_tokens),0)) FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=r.run_id AND m.workspace_id=r.workspace_id AND m.user_id=r.user_id),'')
))) FROM runtime_runs r WHERE r.run_id=$1 AND r.workspace_id=$2 AND r.user_id=$3";

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
      ),'model_usage',(
        SELECT jsonb_build_object('attempts',count(*),'known_input_tokens',sum(c.input_tokens),'known_output_tokens',sum(c.output_tokens),
          'known_total_tokens',CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END,
          'incomplete_usage_attempts',count(*) FILTER (WHERE c.usage_status<>'reported'),'provider_reported_cost_usd',sum(c.cost_usd)::text,
          'unpriced_attempts',count(*) FILTER (WHERE c.cost_usd IS NULL),
          'by_model',COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.provider,u.model) FROM (SELECT m.provider,m.model,count(*) AS attempts,sum(c.input_tokens) AS known_input_tokens,sum(c.output_tokens) AS known_output_tokens,CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END AS known_total_tokens,count(*) FILTER (WHERE c.usage_status<>'reported') AS incomplete_usage_attempts,sum(c.cost_usd)::text AS provider_reported_cost_usd,count(*) FILTER (WHERE c.cost_usd IS NULL) AS unpriced_attempts FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=r.run_id AND m.workspace_id=$1 AND m.user_id=$2 GROUP BY m.provider,m.model) u),'[]'::jsonb))
        FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=r.run_id AND m.workspace_id=$1 AND m.user_id=$2
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

pub async fn get(
    ScopedState(state): ScopedState,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let token = match snapshot(&state, id).await {
        Ok(Some(token)) => token,
        Ok(None) => return error(StatusCode::NOT_FOUND, "run_not_found"),
        Err(response) => return response,
    };
    let etag = format!("\"{token}\"");
    if not_modified(
        headers
            .get(header::IF_NONE_MATCH)
            .and_then(|value| value.to_str().ok()),
        &etag,
    ) {
        return with_etag(StatusCode::NOT_MODIFIED.into_response(), &etag);
    }
    match load(&state, id).await {
        Ok(value) => with_etag(Json(value).into_response(), &etag),
        Err(response) => response,
    }
}

async fn snapshot(state: &AppState, id: Uuid) -> Result<Option<String>, Response> {
    match query(
        state,
        SNAPSHOT_SQL,
        &[&id, &state.principal.workspace_id, &state.principal.user_id],
    )
    .await?
    {
        Some(Value::String(token))
            if token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            Ok(Some(token))
        }
        Some(_) => Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "database_unavailable",
        )),
        None => Ok(None),
    }
}

pub(crate) fn not_modified(header: Option<&str>, etag: &str) -> bool {
    header.is_some_and(|header| {
        header.split(',').any(|part| {
            let part = part.trim();
            part == "*" || part == etag || part.strip_prefix("W/") == Some(etag)
        })
    })
}

fn with_etag(mut response: Response, etag: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(etag) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
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
      'persistent_issues',COALESCE((SELECT jsonb_agg(to_jsonb(o)||jsonb_build_object('title',i.snapshot->>'title','triage',scout_issue_triage(i.issue_id))) FROM issue_occurrences o JOIN issues i USING(issue_id,workspace_id) WHERE o.run_id=r.run_id AND o.workspace_id=r.workspace_id),'[]'::jsonb),
      'fix_verification',(SELECT scout_verification_summary(v) FROM issue_verifications v WHERE v.run_id=r.run_id AND v.workspace_id=r.workspace_id),
      'reproductions',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at,v.reproduction_id) FROM runtime_reproductions v WHERE v.source_run_id=r.run_id OR v.replay_run_id=r.run_id),'[]'::jsonb),
      'automatic_reproductions',COALESCE((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('child_job',CASE WHEN j.job_id IS NULL THEN NULL ELSE jsonb_build_object('job_id',j.job_id,'status',j.status,'run_id',j.run_id,'error',j.error,'cancel_id',j.cancel_id,'cancel_requested_at',j.cancel_requested_at,'parent_job_id',j.parent_job_id) END,'reproduction',(SELECT to_jsonb(v) FROM runtime_reproductions v WHERE v.source_action_id=t.source_action_id AND v.source_run_id=t.source_run_id)) ORDER BY t.created_at,t.task_id) FROM automatic_reproduction_tasks t JOIN browser_jobs p ON p.job_id=t.source_job_id AND p.run_id=t.source_run_id JOIN runtime_runs s ON s.run_id=t.source_run_id LEFT JOIN browser_jobs j ON j.job_id=t.child_job_id AND j.parent_job_id=p.job_id AND j.automatic_source_action_id=t.source_action_id AND j.workspace_id=r.workspace_id AND j.user_id=r.user_id WHERE (t.source_run_id=r.run_id OR j.run_id=r.run_id) AND p.workspace_id=r.workspace_id AND p.user_id=r.user_id AND s.workspace_id=r.workspace_id AND s.user_id=r.user_id),'[]'::jsonb),
      'finding_reviews',COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.created_at,f.review_id) FROM finding_reviews f WHERE f.workspace_id=r.workspace_id AND f.user_id=r.user_id AND (f.run_id=r.run_id OR f.action_id IN (SELECT source_action_id FROM runtime_reproductions WHERE replay_run_id=r.run_id))),'[]'::jsonb),
      'model_requests',COALESCE((SELECT jsonb_agg(to_jsonb(mr)-'spec' ORDER BY mr.created_at,mr.request_id) FROM model_requests mr WHERE mr.run_id=r.run_id),'[]'::jsonb),
      'model_calls',COALESCE((SELECT jsonb_agg(jsonb_build_object('call_id',c.call_id,'request_id',c.request_id,'attempt',c.attempt,'state',c.state,'started_at',c.started_at,'finished_at',c.finished_at,'elapsed_ms',c.elapsed_ms,'http_status',c.http_status,'input_tokens',c.input_tokens,'output_tokens',c.output_tokens,'cached_input_tokens',c.cached_input_tokens,'cache_write_tokens',c.cache_write_tokens,'reasoning_tokens',c.reasoning_tokens,'usage_status',c.usage_status,'cost_usd',c.cost_usd::text,'returned_model',c.returned_model,'routed_provider',c.routed_provider,'error',c.error) ORDER BY c.started_at,c.call_id) FROM model_calls c JOIN model_requests mr USING(request_id) WHERE mr.run_id=r.run_id AND mr.workspace_id=r.workspace_id AND mr.user_id=r.user_id),'[]'::jsonb),
      'model_usage',(SELECT jsonb_build_object('attempts',count(*),'known_input_tokens',sum(c.input_tokens),'known_output_tokens',sum(c.output_tokens),'known_total_tokens',CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END,'by_model',COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.provider,u.model) FROM (SELECT m.provider,m.model,count(*) AS attempts,sum(c.input_tokens) AS known_input_tokens,sum(c.output_tokens) AS known_output_tokens,CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END AS known_total_tokens,count(*) FILTER (WHERE c.usage_status<>'reported') AS incomplete_usage_attempts,sum(c.cost_usd)::text AS provider_reported_cost_usd,count(*) FILTER (WHERE c.cost_usd IS NULL) AS unpriced_attempts FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=r.run_id GROUP BY m.provider,m.model) u),'[]'::jsonb),'incomplete_usage_attempts',count(*) FILTER (WHERE c.usage_status<>'reported'),'pending_requests',(SELECT count(*) FROM model_requests WHERE run_id=r.run_id AND state IN ('queued','preparing','dispatched')),'provider_reported_cost_usd',sum(c.cost_usd)::text,'unpriced_attempts',count(*) FILTER (WHERE c.cost_usd IS NULL)) FROM model_calls c JOIN model_requests mr USING(request_id) WHERE mr.run_id=r.run_id))
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

#[cfg(test)]
mod tests {
    use super::not_modified;

    #[test]
    fn unchanged_run_reports_skip_the_body() {
        let etag = "\"abc123\"";
        assert!(not_modified(Some("\"abc123\""), etag));
        assert!(not_modified(Some("W/\"abc123\""), etag));
        assert!(not_modified(Some(" \"abc123\" , \"other\""), etag));
        assert!(not_modified(Some("*"), etag));
        assert!(!not_modified(None, etag));
        assert!(!not_modified(Some("\"different\""), etag));
    }
}
