//! Cross-run exploration memory: list remembered app scopes and forget one.
//! Memory is a derived projection of runs; forgetting never removes evidence.
use crate::{error, identity::ScopedState, query};
use axum::{
    Json,
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use uuid::Uuid;

pub async fn list(ScopedState(state): ScopedState) -> Response {
    let sql = "SELECT jsonb_build_object('scopes',COALESCE(jsonb_agg(item ORDER BY updated_at DESC,scope_id),'[]'::jsonb),'limit',100) FROM (
      SELECT s.updated_at,s.scope_id,jsonb_build_object('scope_id',s.scope_id,'origin',s.origin,'viewport_profile',s.viewport_profile,
        'auth_scope',s.auth_scope,'execution_mode',s.execution_mode,'runs',s.runs,'last_run_id',s.last_run_id,
        'created_at',s.created_at,'updated_at',s.updated_at,
        'pages',(SELECT count(*) FROM app_memory_pages p WHERE p.scope_id=s.scope_id),
        'controls',(SELECT count(*) FROM app_memory_controls c WHERE c.scope_id=s.scope_id),
        'tried_controls',(SELECT count(*) FROM app_memory_controls c WHERE c.scope_id=s.scope_id AND c.attempts>0),
        'untried_controls',(SELECT count(*) FROM app_memory_controls c WHERE c.scope_id=s.scope_id AND c.attempts=0 AND c.blocked_reason IS NULL),
        'in_use',EXISTS(SELECT 1 FROM runtime_runs r WHERE r.run_id=s.last_run_id AND r.lifecycle='active')) AS item
      FROM app_memory_scopes s WHERE s.workspace_id=$1 AND s.user_id=$2 ORDER BY s.updated_at DESC,s.scope_id LIMIT 100) t";
    match query(
        &state,
        sql,
        &[&state.principal.workspace_id, &state.principal.user_id],
    )
    .await
    {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => error(StatusCode::SERVICE_UNAVAILABLE, "database_unavailable"),
        Err(response) => response,
    }
}

pub async fn forget(ScopedState(state): ScopedState, Path(scope_id): Path<Uuid>) -> Response {
    let Some(queue) = &state.jobs else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "browser_queue_unavailable");
    };
    match queue.forget_memory(scope_id).await {
        Ok(value) => Json(value).into_response(),
        Err(code) => error(
            match code {
                "memory_scope_not_found" => StatusCode::NOT_FOUND,
                "memory_scope_in_use" => StatusCode::CONFLICT,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            },
            code,
        ),
    }
}
