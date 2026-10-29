//! Permanent issue identities and candidate-specific fix verification.
use crate::{agent, error, identity::ScopedState, jobs, query};
use axum::{
    Json,
    body::to_bytes,
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    pub query: Option<String>,
    pub outcome: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}
impl Filters {
    fn valid(&self) -> bool {
        self.query
            .as_ref()
            .is_none_or(|s| s.len() <= 200 && !s.chars().any(char::is_control))
            && self.outcome.as_deref().is_none_or(|s| {
                matches!(
                    s,
                    "unverified"
                        | "running"
                        | "resolved"
                        | "still_reproducible"
                        | "blocked"
                        | "inconclusive"
                )
            })
            && (0..=100000).contains(&self.offset.unwrap_or(0))
            && (1..=50).contains(&self.limit.unwrap_or(20))
    }
}
pub async fn list(ScopedState(state): ScopedState, Query(filters): Query<Filters>) -> Response {
    if !filters.valid() {
        return error(StatusCode::BAD_REQUEST, "invalid_issue_filters");
    }
    let offset = filters.offset.unwrap_or(0);
    let limit = filters.limit.unwrap_or(20);
    let sql = "WITH candidates AS (SELECT scout_issue_summary(i) item FROM issues i WHERE workspace_id=$1 AND user_id=$2 AND ($3::text IS NULL OR position(lower($3) in lower(COALESCE(i.snapshot->>'title','')||' '||i.source_target_url))>0)),filtered AS (SELECT item FROM candidates WHERE $4::text IS NULL OR COALESCE(item->'latest_verification'->>'outcome',CASE WHEN item->'latest_verification'->>'status' IN ('queued','running') THEN 'running' ELSE 'unverified' END)=$4) SELECT jsonb_build_object('issues',COALESCE((SELECT jsonb_agg(item ORDER BY item->>'last_seen_at' DESC,item->>'issue_id') FROM (SELECT item FROM filtered ORDER BY item->>'last_seen_at' DESC,item->>'issue_id' OFFSET $5 LIMIT $6) page),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),'offset',$5::bigint,'limit',$6::bigint,'next_offset',CASE WHEN (SELECT count(*) FROM filtered)>$5+$6 THEN $5+$6 ELSE NULL END,'untrusted_app_content',true,'verification_scope','individual_candidate_not_global_resolution')";
    match query(
        &state,
        sql,
        &[
            &state.principal.workspace_id,
            &state.principal.user_id,
            &filters.query,
            &filters.outcome,
            &offset,
            &limit,
        ],
    )
    .await
    {
        Ok(Some(mut v)) => {
            // Bound a page by bytes as well as row count; use the actual returned
            // offset so a long URL or label cannot silently skip later issues.
            while v.to_string().len() > 120 * 1024
                && v["issues"].as_array().is_some_and(|items| items.len() > 1)
            {
                v["issues"].as_array_mut().unwrap().pop();
            }
            let returned = v["issues"].as_array().map_or(0, |items| items.len()) as i64;
            v["returned"] = json!(returned);
            v["next_offset"] = if offset + returned < v["total"].as_i64().unwrap_or(0) {
                json!(offset + returned)
            } else {
                Value::Null
            };
            if v.to_string().len() > 128 * 1024 {
                return error(StatusCode::PAYLOAD_TOO_LARGE, "issue_summary_too_large");
            }
            Json(v).into_response()
        }
        Ok(None) => error(StatusCode::SERVICE_UNAVAILABLE, "issues_unavailable"),
        Err(r) => r,
    }
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryPage {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
    pub expected_revision: Option<i64>,
}
impl HistoryPage {
    fn valid(&self) -> bool {
        (0..=100000).contains(&self.offset.unwrap_or(0))
            && (1..=10).contains(&self.limit.unwrap_or(5))
            && self.expected_revision.is_none_or(|v| v >= 1)
    }
}
pub async fn detail(
    ScopedState(state): ScopedState,
    Path(id): Path<Uuid>,
    Query(page): Query<HistoryPage>,
) -> Response {
    if id.is_nil() || !page.valid() {
        return error(StatusCode::BAD_REQUEST, "invalid_issue_history_request");
    }
    let offset = page.offset.unwrap_or(0);
    let limit = page.limit.unwrap_or(5);
    let sql="SELECT jsonb_build_object('issue',scout_issue_summary(i),'original',i.snapshot,'usage',jsonb_build_object('source_run',scout_run_usage(i.source_run_id)),
      'occurrences',jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY created_at,action_id) FROM (SELECT * FROM issue_occurrences WHERE issue_id=i.issue_id ORDER BY created_at,action_id OFFSET $3 LIMIT $4) o),'[]'::jsonb),'total',(SELECT count(*) FROM issue_occurrences WHERE issue_id=i.issue_id)),
      'verifications',jsonb_build_object('items',COALESCE((SELECT jsonb_agg(scout_verification_summary(v) ORDER BY created_at DESC,verification_id DESC) FROM (SELECT * FROM issue_verifications WHERE issue_id=i.issue_id ORDER BY created_at DESC,verification_id DESC OFFSET $3 LIMIT $4) v),'[]'::jsonb),'total',(SELECT count(*) FROM issue_verifications WHERE issue_id=i.issue_id)),
      'history',jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(e)-'exported_at' ORDER BY seq) FROM (SELECT * FROM issue_events WHERE issue_id=i.issue_id ORDER BY seq OFFSET $3 LIMIT $4) e),'[]'::jsonb),'total',(SELECT count(*) FROM issue_events WHERE issue_id=i.issue_id))) FROM issues i WHERE issue_id=$1 AND workspace_id=$2 AND user_id=$5";
    let mut value = match query(
        &state,
        sql,
        &[
            &id,
            &state.principal.workspace_id,
            &offset,
            &limit,
            &state.principal.user_id,
        ],
    )
    .await
    {
        Ok(Some(v)) => v,
        Ok(None) => return error(StatusCode::NOT_FOUND, "issue_not_found"),
        Err(r) => return r,
    };
    if page
        .expected_revision
        .is_some_and(|v| value["issue"]["revision"] != v)
    {
        return error(
            StatusCode::CONFLICT,
            "issue_snapshot_changed_restart_from_offset_zero",
        );
    }
    let run_id = Uuid::parse_str(value["issue"]["source_run_id"].as_str().unwrap()).unwrap();
    let action_id = value["issue"]["source_action_id"].clone();
    let report = match agent::run_report(&state, run_id).await {
        Ok(v) => v,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "issue_source_report_unavailable",
            );
        }
    };
    let Some(action) = report["actions"]
        .as_array()
        .and_then(|items| items.iter().find(|a| a["action_id"] == action_id))
    else {
        return error(StatusCode::CONFLICT, "issue_source_action_unavailable");
    };
    value["handoff"] = agent::report::issue_packet(&report, action);
    value["execution_mode"] = report["run"]["config"]["execution_mode"].clone();
    value["handoff"]["issue_id"] = json!(id);
    match query(
        &state,
        "SELECT to_jsonb(revision) FROM issues WHERE issue_id=$1 AND workspace_id=$2",
        &[&id, &state.principal.workspace_id],
    )
    .await
    {
        Ok(Some(revision)) if revision == value["issue"]["revision"] => {}
        Ok(_) => {
            return error(
                StatusCode::CONFLICT,
                "issue_snapshot_changed_restart_from_offset_zero",
            );
        }
        Err(r) => return r,
    }
    for key in ["occurrences", "verifications", "history"] {
        let total = value[key]["total"].as_i64().unwrap_or(0);
        value[key]["pagination"] = json!({"offset":offset,"limit":limit,"next_offset":if total>offset+limit{Some(offset+limit)}else{None},"expected_revision":value["issue"]["revision"]});
    }
    value["verification_scope"] = json!(
        "A result describes the recorded behavior on one candidate deployment. It does not establish a production fix, a root cause, complete app coverage or human confirmation."
    );
    value["untrusted_app_content"] = json!(true);
    if value.to_string().len() > 128 * 1024 {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "issue_history_too_large_reduce_limit",
        );
    }
    Json(value).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationInput {
    pub verification_id: Uuid,
    pub candidate_url: String,
    pub deployment_ref: Option<String>,
    pub auth_mode: Option<String>,
    pub session_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub task_id: Option<Uuid>,
}
pub async fn submit(
    ScopedState(state): ScopedState,
    Path(id): Path<Uuid>,
    Json(input): Json<VerificationInput>,
) -> Response {
    if id.is_nil() || input.verification_id.is_nil() {
        return error(StatusCode::BAD_REQUEST, "invalid_verification_id");
    }
    let mut body = json!({"job_id":input.verification_id,"kind":"verify_fix","issue_id":id,"target_url":input.candidate_url});
    for (key, value) in [
        ("deployment_ref", json!(input.deployment_ref)),
        ("auth_mode", json!(input.auth_mode)),
        ("session_id", json!(input.session_id)),
        ("project_id", json!(input.project_id)),
        ("task_id", json!(input.task_id)),
    ] {
        if !value.is_null() {
            body[key] = value;
        }
    }
    let submission: jobs::Submission =
        serde_json::from_value(body).expect("typed verification submission");
    let response = jobs::submit(ScopedState(state), Ok(Json(submission))).await;
    if !response.status().is_success() {
        return response;
    }
    let status = response.status();
    let Ok(bytes) = to_bytes(response.into_body(), 128 * 1024).await else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "verification_receipt_unavailable_retry_same_id",
        );
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "verification_receipt_unavailable_retry_same_id",
        );
    };
    value["verification_id"] = json!(input.verification_id);
    value["issue_id"] = json!(id);
    value["next"] = json!({"verification":{"name":"scout_get_verification","arguments":{"verification_id":input.verification_id}},"progress":{"name":"scout_get_progress","arguments":{"job_id":input.verification_id}},"issue":{"name":"scout_get_issue","arguments":{"issue_id":id}},"poll_after_ms":5000,"disconnect_cancels_work":false});
    (status, Json(value)).into_response()
}
pub async fn verification(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    if id.is_nil() {
        return error(StatusCode::BAD_REQUEST, "invalid_verification_id");
    }
    match query(&state,"SELECT jsonb_build_object('verification',scout_verification_summary(v),'original',i.snapshot,'source_run_id',i.source_run_id,'source_action_id',i.source_action_id,'source_usage',scout_run_usage(i.source_run_id),'untrusted_app_content',true,'verified_fixed_globally',false) FROM issue_verifications v JOIN issues i USING(issue_id,workspace_id) WHERE verification_id=$1 AND v.workspace_id=$2 AND v.user_id=$3",&[&id,&state.principal.workspace_id,&state.principal.user_id]).await {Ok(Some(mut v))=>{v["next"]=json!({"issue":{"name":"scout_get_issue","arguments":{"issue_id":v["verification"]["issue_id"]}},"progress":{"name":"scout_get_progress","arguments":{"job_id":v["verification"]["job_id"]}},"report":{"name":"scout_get_report","arguments":{"job_id":v["verification"]["job_id"]}}});Json(v).into_response()},Ok(None)=>error(StatusCode::NOT_FOUND,"verification_not_found"),Err(r)=>r}
}
