use crate::{AppState, WORKSPACE_ID, error, gateway::USER_ID, query};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

pub async fn list(State(state): State<AppState>) -> Response {
    match query(&state,"SELECT jsonb_build_object('requests',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY created_at DESC) FROM (SELECT * FROM browser_access_requests WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50) a),'[]'::jsonb),'sessions',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY created_at DESC) FROM (SELECT session_id,origin,execution_mode,created_at,expires_at,revoked_at,verification FROM browser_sessions WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50) s),'[]'::jsonb))",&[&WORKSPACE_ID,&USER_ID]).await {
        Ok(Some(value))=>Json(value).into_response(),Ok(None)=>Json(json!({"requests":[],"sessions":[]})).into_response(),Err(r)=>r,
    }
}
async fn forward(
    state: AppState,
    id: Uuid,
    action: &str,
    headers: HeaderMap,
    body: Option<Value>,
) -> Response {
    let session = action == "revoke";
    let sql = if session {
        "SELECT jsonb_build_object('owned',true) FROM browser_sessions WHERE session_id=$1 AND workspace_id=$2 AND user_id=$3"
    } else {
        "SELECT jsonb_build_object('owned',true) FROM browser_access_requests WHERE access_id=$1 AND workspace_id=$2 AND user_id=$3 AND status IN ('waiting','active') AND expires_at>now()"
    };
    match query(&state, sql, &[&id, &WORKSPACE_ID, &USER_ID]).await {
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::NOT_FOUND, "access_not_found"),
        Err(r) => return r,
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "private_browser_unavailable",
            );
        }
    };
    let base = std::env::var("SCOUT_PRIVATE_BROWSER_URL")
        .unwrap_or_else(|_| "http://browser-worker:8083".into());
    let url = format!(
        "{}/{}/{}/{}",
        base.trim_end_matches('/'),
        if session { "sessions" } else { "access" },
        id,
        action
    );
    let mut request = if action == "screen" {
        client.get(url)
    } else {
        client.post(url)
    };
    request = request.header("authorization", state.bearer.as_ref());
    if let Some(lease) = headers.get("x-scout-access-lease") {
        request = request.header("x-scout-access-lease", lease);
    }
    if let Some(value) = body {
        request = request.json(&value);
    }
    // Private input and live frames never enter the model/evidence journal.
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            let frame = response.headers().get("x-scout-frame-id").cloned();
            let is_image = action == "screen" && status.is_success();
            let bytes = match response.bytes().await {
                Ok(b) => b,
                Err(_) => return error(StatusCode::BAD_GATEWAY, "private_browser_unavailable"),
            };
            if bytes.len() > 8_000_000 {
                return error(StatusCode::BAD_GATEWAY, "private_frame_too_large");
            }
            let mut result = (status, bytes).into_response();
            result.headers_mut().insert(
                "content-type",
                if is_image {
                    "image/png"
                } else {
                    "application/json"
                }
                .parse()
                .unwrap(),
            );
            result
                .headers_mut()
                .insert("cache-control", "no-store".parse().unwrap());
            result
                .headers_mut()
                .insert("x-content-type-options", "nosniff".parse().unwrap());
            if let Some(frame) = frame {
                result.headers_mut().insert("x-scout-frame-id", frame);
            }
            result
        }
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "private_browser_unavailable",
        ),
    }
}
pub async fn screen(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    forward(state, id, "screen", headers, None).await
}
pub async fn control(
    State(state): State<AppState>,
    Path((id, action)): Path<(Uuid, String)>,
    headers: HeaderMap,
    input: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !matches!(
        action.as_str(),
        "start" | "input" | "complete" | "skip" | "cancel"
    ) {
        return error(StatusCode::NOT_FOUND, "access_operation_not_found");
    }
    let Ok(Json(body)) = input else {
        return error(StatusCode::BAD_REQUEST, "invalid_private_input");
    };
    if !body.is_object() || body.to_string().len() > 8192 {
        return error(StatusCode::BAD_REQUEST, "invalid_private_input");
    }
    forward(state, id, &action, headers, Some(body)).await
}
pub async fn revoke(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    forward(state, id, "revoke", HeaderMap::new(), Some(json!({}))).await
}
