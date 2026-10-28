use crate::{AppState, WORKSPACE_ID, error, query};
use axum::{
    Json,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use uuid::Uuid;

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
fn asset(body: &'static str, content_type: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_SECURITY_POLICY, CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        body,
    )
        .into_response()
}
pub async fn index() -> Response {
    asset(
        include_str!("../../web/index.html"),
        "text/html; charset=utf-8",
    )
}
pub async fn script() -> Response {
    asset(
        include_str!("../../web/app.js"),
        "text/javascript; charset=utf-8",
    )
}
pub async fn report_export_script() -> Response {
    asset(
        include_str!("../../web/report-export.js"),
        "text/javascript; charset=utf-8",
    )
}
pub async fn report_bundle_script() -> Response {
    asset(
        include_str!("../../web/report-bundle.js"),
        "text/javascript; charset=utf-8",
    )
}
pub async fn style() -> Response {
    asset(include_str!("../../web/app.css"), "text/css; charset=utf-8")
}

async fn bytes(state: &AppState, row: Value) -> Response {
    if row["status"] != "available" {
        return error(StatusCode::CONFLICT, "evidence_not_available");
    }
    let Some(gateway) = &state.gateway else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "evidence_unavailable");
    };
    let (Some(key), Some(sha), Some(length)) = (
        row["object_key"].as_str(),
        row["sha256"].as_str(),
        row["byte_length"].as_u64(),
    ) else {
        return error(StatusCode::CONFLICT, "incomplete_evidence");
    };
    match gateway.evidence_bytes(key, sha, length).await {
        Ok(body) => (
            [
                (
                    header::CONTENT_TYPE,
                    if key.ends_with(".png") {
                        "image/png"
                    } else {
                        "application/json"
                    },
                ),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            body,
        )
            .into_response(),
        Err(code) => error(StatusCode::BAD_GATEWAY, code),
    }
}
pub async fn capture_image(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    match query(&state,"SELECT to_jsonb(c) FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE c.capture_id=$1 AND r.workspace_id=$2",&[&id,&WORKSPACE_ID]).await {
        Ok(Some(row))=>bytes(&state,row).await,Ok(None)=>error(StatusCode::NOT_FOUND,"capture_not_found"),Err(r)=>r,
    }
}
pub async fn artifact(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    match query(&state,"SELECT to_jsonb(a) FROM runtime_artifacts a JOIN runtime_runs r USING(run_id) WHERE a.artifact_id=$1 AND r.workspace_id=$2",&[&id,&WORKSPACE_ID]).await {
        Ok(Some(row))=>bytes(&state,row).await,Ok(None)=>error(StatusCode::NOT_FOUND,"artifact_not_found"),Err(r)=>r,
    }
}
pub async fn operations(State(state): State<AppState>) -> Response {
    let sql="SELECT jsonb_build_object(
      'runs',(SELECT count(*) FROM runtime_runs WHERE workspace_id=$1),
      'active_runs',(SELECT count(*) FROM runtime_runs WHERE workspace_id=$1 AND lifecycle='active'),
      'failed_runs',(SELECT count(*) FROM runtime_runs WHERE workspace_id=$1 AND lifecycle='failed'),
      'settling_frames',(SELECT count(*) FROM runtime_events e JOIN runtime_runs r USING(run_id) WHERE workspace_id=$1 AND e.event_type='action.settling_frame'),
      'captures',(SELECT count(*) FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE workspace_id=$1),
      'pending_captures',(SELECT count(*) FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE workspace_id=$1 AND c.status='pending_upload'),
      'failed_captures',(SELECT count(*) FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE workspace_id=$1 AND c.status='failed'),
      'pending_artifacts',(SELECT count(*) FROM runtime_artifacts a JOIN runtime_runs r USING(run_id) WHERE workspace_id=$1 AND a.status='pending_upload'),
      'runtime_events',(SELECT count(*) FROM runtime_events e JOIN runtime_runs r USING(run_id) WHERE workspace_id=$1),
      'pending_runtime_events',(SELECT count(*) FROM runtime_events e JOIN runtime_runs r USING(run_id) WHERE workspace_id=$1 AND e.exported_at IS NULL),
      'last_runtime_export',(SELECT max(exported_at) FROM runtime_events e JOIN runtime_runs r USING(run_id) WHERE workspace_id=$1),
      'model_calls',(SELECT count(*) FROM model_calls c JOIN model_requests r USING(request_id) WHERE workspace_id=$1),
      'pending_model_events',(SELECT count(*) FROM model_events e JOIN model_requests r USING(request_id) WHERE workspace_id=$1 AND e.exported_at IS NULL),
      'pending_model_payloads',(SELECT count(*) FROM model_payloads p JOIN model_calls c USING(call_id) JOIN model_requests r USING(request_id) WHERE workspace_id=$1 AND p.uploaded_at IS NULL),
      'as_of',now())";
    match query(&state, sql, &[&WORKSPACE_ID]).await {
        Ok(Some(mut value)) => {
            value["database"] = json!("reachable");
            Json(value).into_response()
        }
        Ok(None) => Json(json!({})).into_response(),
        Err(r) => r,
    }
}
