use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{StatusCode, uri::Authority},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use gateway::USER_ID;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio_postgres::Client;
use uuid::Uuid;
pub mod access;
pub mod agent;
pub mod gateway;
pub mod jobs;
pub mod models;
pub mod reviews;
pub mod ui;

/// Fixed local fixture workspace. Multi-user authentication is a later increment.
pub const WORKSPACE_ID: Uuid = Uuid::from_u128(0x00000000000040008000000000000001);

#[derive(Clone)]
pub struct AppState {
    pub database: Option<Arc<Client>>,
    pub gateway: Option<Arc<gateway::Gateway>>,
    pub jobs: Option<Arc<jobs::Queue>>,
    pub reviews: Option<Arc<reviews::Reviews>>,
    bearer: Arc<str>,
    dev_auth_bypass: bool,
}

impl AppState {
    pub fn new(database: Option<Arc<Client>>, token: &str) -> Result<Self, &'static str> {
        if token.len() < 32
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err(
                "SCOUT_API_TOKEN must contain at least 32 letters, digits, underscores or hyphens",
            );
        }
        Ok(Self {
            database,
            gateway: None,
            jobs: None,
            reviews: None,
            bearer: Arc::from(format!("Bearer {token}")),
            dev_auth_bypass: false,
        })
    }

    /// Explicit local-development convenience. Worker and CLI bearer
    /// authentication remains available and the token is still required.
    pub fn with_dev_auth_bypass(mut self, enabled: bool) -> Self {
        self.dev_auth_bypass = enabled;
        self
    }
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/readyz", get(ready))
        .route("/v1/runs", get(runs))
        .route("/v1/runs/{run_id}", get(run))
        .route("/v1/runs/{run_id}/graph", get(graph))
        .route("/v1/runs/{run_id}/events", get(agent::events))
        .route("/v1/agent/tools", get(agent::catalog))
        .route("/v1/agent/tools/{name}", axum::routing::post(agent::http_call))
        .route(
            "/v1/actions/{action_id}/reviews",
            axum::routing::post(reviews::submit),
        )
        .route(
            "/v1/runs/{run_id}/cancel",
            axum::routing::post(jobs::cancel_run),
        )
        .route(
            "/v1/runs/{run_id}/automatic-reproductions/cancel",
            axum::routing::post(jobs::cancel_automatic),
        )
        .route("/v1/captures/{capture_id}", get(capture))
        .route("/v1/captures/{capture_id}/image", get(ui::capture_image))
        .route("/v1/artifacts/{artifact_id}/content", get(ui::artifact))
        .route("/v1/operations", get(ui::operations))
        .route("/v1/browser-jobs", get(jobs::list).post(jobs::submit))
        .route("/v1/browser-jobs/{job_id}", get(jobs::get_job))
        .route(
            "/v1/exploration-settings",
            get(jobs::exploration_settings).post(jobs::save_exploration_settings),
        )
        .route(
            "/v1/browser-jobs/{job_id}/cancel",
            axum::routing::post(jobs::cancel_job),
        )
        .route("/v1/browser-access", get(access::list))
        .route("/v1/browser-access/{id}/screen", get(access::screen))
        .route(
            "/v1/browser-access/{id}/{operation}",
            axum::routing::post(access::control),
        )
        .route(
            "/v1/browser-sessions/{id}/revoke",
            axum::routing::post(access::revoke),
        )
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/model-providers", get(gateway::providers))
        .route("/v1/model-requests", axum::routing::post(gateway::submit))
        .route("/v1/model-requests/{request_id}", get(gateway::request))
        .route("/v1/usage", get(gateway::usage_report))
        .layer(axum::extract::DefaultBodyLimit::max(65_536))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize));
    let mcp = Router::new()
        .route_service("/mcp", agent::service(state.clone()))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize_mcp));
    Router::new()
        .route("/", get(ui::index))
        .route("/assets/app.js", get(ui::script))
        .route("/assets/report-export.js", get(ui::report_export_script))
        .route("/assets/report-bundle.js", get(ui::report_bundle_script))
        .route("/assets/app.css", get(ui::style))
        .route("/v1/auth-mode", get(auth_mode))
        .route("/healthz", get(|| async { Json(json!({"status":"ok","service":"scout-api","version":env!("CARGO_PKG_VERSION")})) }))
        .merge(protected)
        .merge(mcp)
        .with_state(state)
}

// Agent clients use the explicit local developer token. The GUI's development
// convenience never makes the MCP endpoint anonymous or cross-origin.
async fn authorize_mcp(State(state): State<AppState>,request: Request,next: Next) -> Response {
    if (request.headers().contains_key("origin")||request.headers().contains_key("sec-fetch-site")) && !local_development_request(&request) {
        return error(StatusCode::FORBIDDEN,"mcp_origin_not_allowed");
    }
    let count=request.headers().get_all("authorization").iter().count();
    let presented=request.headers().get("authorization").map(|v|v.as_bytes()).unwrap_or_default();
    if count!=1||!bool::from(presented.ct_eq(state.bearer.as_bytes())) {
        let mut response=error(StatusCode::UNAUTHORIZED,"unauthorized");
        response.headers_mut().insert("www-authenticate","Bearer realm=\"scout-local\"".parse().unwrap());
        response.headers_mut().insert("cache-control","no-store".parse().unwrap());
        return response;
    }
    let mut response=next.run(request).await;
    response.headers_mut().insert("cache-control","no-store".parse().unwrap());
    response
}

async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let authorization_count = request.headers().get_all("authorization").iter().count();
    let presented = request
        .headers()
        .get("authorization")
        .map(|h| h.as_bytes())
        .unwrap_or_default();
    let valid_bearer =
        authorization_count == 1 && bool::from(presented.ct_eq(state.bearer.as_bytes()));
    let local_development =
        authorization_count == 0 && state.dev_auth_bypass && local_development_request(&request);
    if !valid_bearer && !local_development {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

fn local_authority(value: &str) -> Option<Authority> {
    if value.contains('@') || value.trim() != value {
        return None;
    }
    let authority: Authority = value.parse().ok()?;
    let host = authority.host();
    if !host.eq_ignore_ascii_case("localhost") && host != "127.0.0.1" && host != "[::1]" {
        return None;
    }
    // Validate the original suffix as well: Authority permits an empty or
    // nonnumeric port even though it cannot be used as an origin port.
    let suffix = value.get(host.len()..)?;
    if !suffix.is_empty() {
        let port = suffix.strip_prefix(':')?;
        if port.is_empty()
            || !port.bytes().all(|c| c.is_ascii_digit())
            || port.parse::<u16>().ok()? == 0
        {
            return None;
        }
    }
    Some(authority)
}

fn same_authority(left: &Authority, right: &Authority, scheme: &str) -> bool {
    let default_port = if scheme == "https" { 443 } else { 80 };
    left.host().eq_ignore_ascii_case(right.host())
        && left.port_u16().unwrap_or(default_port) == right.port_u16().unwrap_or(default_port)
}

/// Host and browser-origin fences for an explicitly enabled, loopback-only
/// development deployment. Forwarded headers never broaden this decision.
fn local_development_request(request: &Request) -> bool {
    let headers = request.headers();
    if headers.get_all("host").iter().count() != 1 {
        return false;
    }
    let Some(authority) = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .and_then(local_authority)
    else {
        return false;
    };
    let scheme = request.uri().scheme_str().unwrap_or("http");
    if !matches!(scheme, "http" | "https") {
        return false;
    }
    if request.uri().authority().is_some_and(|uri_authority| {
        local_authority(uri_authority.as_str()).is_none()
            || !same_authority(&authority, uri_authority, scheme)
    }) {
        return false;
    }
    let site = headers.get_all("sec-fetch-site");
    if site.iter().count() > 1
        || site
            .iter()
            .next()
            .is_some_and(|value| !matches!(value.to_str(), Ok("same-origin" | "none")))
    {
        return false;
    }
    let origins = headers.get_all("origin");
    if origins.iter().count() > 1 {
        return false;
    }
    if let Some(value) = origins.iter().next() {
        let Ok(value) = value.to_str() else {
            return false;
        };
        let Ok(origin) = value.parse::<axum::http::Uri>() else {
            return false;
        };
        let Some(origin_authority) = origin.authority() else {
            return false;
        };
        if origin.scheme_str() != Some(scheme)
            || value != format!("{scheme}://{origin_authority}")
            || local_authority(origin_authority.as_str()).is_none()
            || !same_authority(&authority, origin_authority, scheme)
        {
            return false;
        }
    }
    true
}

async fn auth_mode(State(state): State<AppState>, request: Request) -> Response {
    let mode = if state.dev_auth_bypass && local_development_request(&request) {
        "local_development"
    } else {
        "bearer_token"
    };
    let mut response = Json(json!({"mode":mode})).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}

async fn query(
    state: &AppState,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<Option<Value>, Response> {
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "database_unavailable"))?;
    match tokio::time::timeout(Duration::from_secs(5), database.query_opt(sql, params)).await {
        Ok(Ok(row)) => Ok(row.map(|row| row.get::<_, Value>(0))),
        _ => Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "database_unavailable",
        )),
    }
}

async fn ready(State(state): State<AppState>) -> Response {
    if state.gateway.as_ref().is_some_and(|g| !g.is_ready()) {
        return error(StatusCode::SERVICE_UNAVAILABLE, "gateway_not_ready");
    }
    match query(
        &state,
        "SELECT jsonb_build_object('status','ready') FROM runtime_runs LIMIT 1",
        &[],
    )
    .await
    {
        // An empty runs table is valid; the query still verifies the schema exists.
        Ok(_) => Json(json!({"status":"ready"})).into_response(),
        Err(response) => response,
    }
}

async fn capabilities(State(state): State<AppState>) -> Response {
    let effective_settings = match &state.jobs {
        Some(queue) => match queue.effective_settings().await {
            Ok(value) => value["settings"].clone(),
            Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
        },
        None => json!({"maxAutoReproductions":2,"maxAutoReplayActions":12,"settingsRevision":0}),
    };
    let providers = state
        .gateway
        .as_ref()
        .map(|g| g.providers())
        .unwrap_or_else(|| json!({"providers":[]}));
    let configured = providers["providers"]
        .as_array()
        .is_some_and(|p| p.iter().any(|p| p["configured"] == true));
    Json(json!({
        "mode":"local_qa_workspace", "unbounded_exploration":false,
        "bounded_url_exploration":{"entrypoints":["recorder_cli","browser_jobs_api","workspace_ui"],"scope":"operator_controlled_apps","requires_configured_model":true,"coverage_complete":false,
            "interactions":["navigate","click","fill","select","set_checked","scroll","submit"],"interaction_version":"browser-interactions-v2",
            "form_submission":"same_origin_search_or_operator_configured_test_form",
            "action_completion":{"version":"action-completion-v1","timeout_ms":5000,"sampled_frames":true,"network_and_console_evidence":true}},
        "suspect_reproduction":{"entrypoints":["recorder_cli","browser_jobs_api","workspace_ui"],"fresh_browser":true,"attempts_per_source_action":1,"automatic_confirmation":false},
        "automatic_reproduction":{"enabled":state.jobs.is_some(),"opt_in":true,"recursive":false,"automatic_confirmation":false,"max_cases":effective_settings["maxAutoReproductions"],"max_replay_actions":effective_settings["maxAutoReplayActions"],"durable_cancellation":true},
        "exploration_settings":{"editable":state.jobs.is_some(),"revision":effective_settings["settingsRevision"],"origins_editable":false,"credentials_editable":false},
        "finding_review":{"enabled":state.reviews.is_some(),"append_only":true,"optimistic_concurrency":true,"confirmation_requires_reproduction":true,"training_approval":false},
        "workspace_ui":true,"browser_job_submission":state.jobs.is_some(),
        "agent_interface":{"version":1,"mcp_endpoint":"/mcp","http_catalog":"/v1/agent/tools","stdio_bridge":true,"human_review_write":false,"external_browser_driver":false},
        "cancellation":{"queued_jobs":true,"active_explorer_runs":true,"durable":true,"resume":false,"in_flight_provider_calls":"settle_and_account"},
        "app_login":{"manual_handoff":true,"session_reuse":true,"saved_session_hours":24,"google_oauth":false,"private_login_recording":false},
        "frontier_planning":{"version":"frontier-v1","automatic_return":true,"stale_plan_recovery":true,"max_replans":3,"probability_calibrated":false},
        "viewport_profiles":["desktop","tablet","mobile"],
        "model_gateway":true,"model_inference":configured && state.gateway.as_ref().is_some_and(|g|g.is_ready()),
        "model_providers":providers,
        "authentication":"local_bearer_token", "workspace_id":WORKSPACE_ID.to_string()
    })).into_response()
}

async fn runs(State(state): State<AppState>) -> Response {
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
    match query(&state, sql, &[&WORKSPACE_ID, &USER_ID]).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => Json(json!({"runs":[]})).into_response(),
        Err(response) => response,
    }
}

async fn run(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    // One SQL statement gives a consistent database snapshot of all relationships.
    let sql = "SELECT jsonb_build_object('schema_version',1,'run',to_jsonb(r),
      'actions',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.ordinal) FROM runtime_actions a WHERE a.run_id=r.run_id),'[]'::jsonb),
      'captures',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at,c.capture_id) FROM runtime_captures c WHERE c.run_id=r.run_id),'[]'::jsonb),
      'artifacts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.artifact_id) FROM runtime_artifacts a WHERE a.run_id=r.run_id),'[]'::jsonb),
      'events',COALESCE((SELECT jsonb_agg(to_jsonb(e)-'exported_at' ORDER BY e.seq) FROM runtime_events e WHERE e.run_id=r.run_id),'[]'::jsonb),
      'graph',(SELECT graph FROM exploration_graphs WHERE run_id=r.run_id),
      'reproductions',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at,v.reproduction_id) FROM runtime_reproductions v WHERE v.source_run_id=r.run_id OR v.replay_run_id=r.run_id),'[]'::jsonb),
      'automatic_reproductions',COALESCE((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('child_job',CASE WHEN j.job_id IS NULL THEN NULL ELSE jsonb_build_object('job_id',j.job_id,'status',j.status,'run_id',j.run_id,'error',j.error,'cancel_id',j.cancel_id,'cancel_requested_at',j.cancel_requested_at,'parent_job_id',j.parent_job_id) END,'reproduction',(SELECT to_jsonb(v) FROM runtime_reproductions v WHERE v.source_action_id=t.source_action_id AND v.source_run_id=t.source_run_id)) ORDER BY t.created_at,t.task_id) FROM automatic_reproduction_tasks t JOIN browser_jobs p ON p.job_id=t.source_job_id AND p.run_id=t.source_run_id JOIN runtime_runs s ON s.run_id=t.source_run_id LEFT JOIN browser_jobs j ON j.job_id=t.child_job_id AND j.parent_job_id=p.job_id AND j.automatic_source_action_id=t.source_action_id AND j.workspace_id=r.workspace_id AND j.user_id=r.user_id WHERE (t.source_run_id=r.run_id OR j.run_id=r.run_id) AND p.workspace_id=r.workspace_id AND p.user_id=r.user_id AND s.workspace_id=r.workspace_id AND s.user_id=r.user_id),'[]'::jsonb),
      'finding_reviews',COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.created_at,f.review_id) FROM finding_reviews f WHERE f.workspace_id=r.workspace_id AND f.user_id=r.user_id AND (f.run_id=r.run_id OR f.action_id IN (SELECT source_action_id FROM runtime_reproductions WHERE replay_run_id=r.run_id))),'[]'::jsonb),
      'model_requests',COALESCE((SELECT jsonb_agg(to_jsonb(mr)-'spec' ORDER BY mr.created_at,mr.request_id) FROM model_requests mr WHERE mr.run_id=r.run_id),'[]'::jsonb),
      'model_calls',COALESCE((SELECT jsonb_agg(jsonb_build_object('call_id',c.call_id,'request_id',c.request_id,'attempt',c.attempt,'state',c.state,'started_at',c.started_at,'finished_at',c.finished_at,'elapsed_ms',c.elapsed_ms,'http_status',c.http_status,'input_tokens',c.input_tokens,'output_tokens',c.output_tokens,'cached_input_tokens',c.cached_input_tokens,'cache_write_tokens',c.cache_write_tokens,'reasoning_tokens',c.reasoning_tokens,'usage_status',c.usage_status,'cost_usd',c.cost_usd::text,'returned_model',c.returned_model,'routed_provider',c.routed_provider,'error',c.error) ORDER BY c.started_at,c.call_id) FROM model_calls c JOIN model_requests mr USING(request_id) WHERE mr.run_id=r.run_id AND mr.workspace_id=r.workspace_id AND mr.user_id=r.user_id),'[]'::jsonb),
      'model_usage',(SELECT jsonb_build_object('attempts',count(*),'known_input_tokens',sum(c.input_tokens),'known_output_tokens',sum(c.output_tokens),'incomplete_usage_attempts',count(*) FILTER (WHERE c.usage_status<>'reported'),'pending_requests',(SELECT count(*) FROM model_requests WHERE run_id=r.run_id AND state IN ('queued','preparing','dispatched')),'provider_reported_cost_usd',sum(c.cost_usd)::text,'unpriced_attempts',count(*) FILTER (WHERE c.cost_usd IS NULL)) FROM model_calls c JOIN model_requests mr USING(request_id) WHERE mr.run_id=r.run_id))
      FROM runtime_runs r WHERE r.run_id=$1 AND r.workspace_id=$2 AND r.user_id=$3";
    match query(&state, sql, &[&id, &WORKSPACE_ID, &gateway::USER_ID]).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "run_not_found"),
        Err(response) => response,
    }
}

async fn graph(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    match query(
        &state,
        "SELECT graph FROM exploration_graphs WHERE run_id=$1 AND workspace_id=$2",
        &[&id, &WORKSPACE_ID],
    )
    .await
    {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "exploration_not_found"),
        Err(response) => response,
    }
}

async fn capture(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    match query(&state, "SELECT to_jsonb(c) FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE c.capture_id=$1 AND r.workspace_id=$2", &[&id, &WORKSPACE_ID]).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "capture_not_found"),
        Err(response) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    const TOKEN: &str = "fixture_token_for_local_api_tests_only_0001";

    async fn request(path: &str, authorization: Option<&str>) -> Response {
        let app = router(AppState::new(None, TOKEN).unwrap());
        let mut builder = Request::builder().uri(path);
        if let Some(value) = authorization {
            builder = builder.header("authorization", value);
        }
        app.oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn development_request(enabled: bool, path: &str, headers: &[(&str, &str)]) -> Response {
        let app = router(
            AppState::new(None, TOKEN)
                .unwrap()
                .with_dev_auth_bypass(enabled),
        );
        let mut builder = Request::builder().uri(path);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        app.oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn local_development_bypass_is_disabled_by_default() {
        assert!(!AppState::new(None, TOKEN).unwrap().dev_auth_bypass);
        for authorization in [None, Some("Bearer wrong")] {
            let mut headers = vec![("host", "localhost:18080")];
            if let Some(value) = authorization {
                headers.push(("authorization", value));
            }
            assert_eq!(
                development_request(false, "/v1/capabilities", &headers)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }

    #[tokio::test]
    async fn explicit_development_mode_accepts_loopback_browser_and_native_requests() {
        for host in [
            "localhost",
            "localhost:18080",
            "LOCALHOST:18080",
            "127.0.0.1:18080",
            "[::1]",
            "[::1]:18080",
        ] {
            let origin = format!("http://{host}");
            let browser = development_request(
                true,
                "/v1/capabilities",
                &[
                    ("host", host),
                    ("origin", &origin),
                    ("sec-fetch-site", "same-origin"),
                ],
            )
            .await;
            assert_eq!(browser.status(), StatusCode::OK, "{host}");
            assert_eq!(browser.headers()["cache-control"], "no-store");
            assert_eq!(
                development_request(true, "/v1/capabilities", &[("host", host)])
                    .await
                    .status(),
                StatusCode::OK,
                "Native loopback request: {host}"
            );
        }
        assert_eq!(
            development_request(
                true,
                "/v1/capabilities",
                &[("host", "localhost"), ("sec-fetch-site", "none")]
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            development_request(
                true,
                "/v1/capabilities",
                &[("host", "localhost:80"), ("origin", "http://localhost")]
            )
            .await
            .status(),
            StatusCode::OK,
            "Default origin ports are equivalent"
        );
    }

    #[tokio::test]
    async fn development_host_validation_rejects_rebinding_aliases_and_invalid_ports() {
        assert_eq!(
            development_request(true, "/v1/capabilities", &[])
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for host in [
            "evil.test",
            "api:8080",
            "localhost.evil.test:18080",
            "localhost.",
            "localhost:0",
            "localhost:65536",
            "localhost:",
            "localhost:abc",
            "localhost/path",
            "localhost,evil.test",
            "user@localhost",
            "127.1",
            "127.0.0.01",
            "2130706433",
            "0x7f000001",
            "127.0.0.1.evil.test",
            "[::1]:0",
            "[0:0:0:0:0:0:0:1]",
            "",
        ] {
            assert_eq!(
                development_request(true, "/v1/capabilities", &[("host", host)])
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED,
                "Rejected Host: {host}"
            );
        }
        assert_eq!(
            development_request(
                true,
                "/v1/capabilities",
                &[("host", "localhost"), ("host", "evil.test")]
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            development_request(
                true,
                "http://evil.test/v1/capabilities",
                &[("host", "localhost")]
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            development_request(
                true,
                "http://user@localhost/v1/capabilities",
                &[("host", "localhost")]
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn development_mode_rejects_cross_origin_or_malformed_browser_metadata() {
        for origin in [
            "null",
            "https://localhost:18080",
            "http://evil.test:18080",
            "http://localhost:18081",
            "http://127.0.0.1:18080",
            "http://localhost.evil.test:18080",
            "http://localhost:18080/",
            "http://localhost:18080/path",
            "http://localhost:18080?query=1",
            "http://localhost:18080#fragment",
            "http://user@localhost:18080",
            "http://localhost:18080, http://evil.test",
        ] {
            assert_eq!(
                development_request(
                    true,
                    "/v1/capabilities",
                    &[("host", "localhost:18080"), ("origin", origin)]
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED,
                "Rejected Origin: {origin}"
            );
        }
        for site in ["cross-site", "same-site", "unknown", "Same-Origin", ""] {
            assert_eq!(
                development_request(
                    true,
                    "/v1/capabilities",
                    &[("host", "localhost:18080"), ("sec-fetch-site", site)]
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED,
                "Rejected Sec-Fetch-Site: {site}"
            );
        }
        for duplicate in ["origin", "sec-fetch-site"] {
            let value = if duplicate == "origin" {
                "http://localhost:18080"
            } else {
                "same-origin"
            };
            assert_eq!(
                development_request(
                    true,
                    "/v1/capabilities",
                    &[
                        ("host", "localhost:18080"),
                        (duplicate, value),
                        (duplicate, value)
                    ]
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            development_request(
                true,
                "/v1/capabilities",
                &[("host", "evil.test"), ("x-forwarded-host", "localhost")]
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED,
            "Forwarded headers cannot opt in a nonlocal Host"
        );
    }

    #[tokio::test]
    async fn development_mode_does_not_override_bad_credentials_or_valid_worker_bearers() {
        for token in ["Bearer wrong", ""] {
            assert_eq!(
                development_request(
                    true,
                    "/v1/capabilities",
                    &[("host", "localhost:18080"), ("authorization", token)]
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let token = format!("Bearer {TOKEN}");
        for enabled in [false, true] {
            assert_eq!(
                development_request(
                    enabled,
                    "/v1/capabilities",
                    &[
                        ("host", "api:8080"),
                        ("authorization", &token),
                        ("origin", "http://other.test"),
                        ("sec-fetch-site", "cross-site")
                    ]
                )
                .await
                .status(),
                StatusCode::OK,
                "An authenticated worker retains its existing access"
            );
        }
        assert_eq!(
            development_request(
                true,
                "/v1/capabilities",
                &[
                    ("host", "localhost:18080"),
                    ("authorization", &token),
                    ("authorization", "Bearer wrong")
                ]
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn auth_mode_is_public_nonsecret_uncached_and_uses_the_same_local_fences() {
        for (enabled, headers, expected) in [
            (false, vec![("host", "localhost:18080")], "bearer_token"),
            (true, vec![("host", "localhost:18080")], "local_development"),
            (true, vec![("host", "api:8080")], "bearer_token"),
            (
                true,
                vec![("host", "localhost:18080"), ("origin", "http://other.test")],
                "bearer_token",
            ),
            (
                true,
                vec![("host", "localhost:18080"), ("sec-fetch-site", "same-site")],
                "bearer_token",
            ),
        ] {
            let response = development_request(enabled, "/v1/auth-mode", &headers).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert!(
                !response
                    .headers()
                    .contains_key("access-control-allow-origin")
            );
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap())
                    .unwrap();
            assert_eq!(body, json!({"mode":expected}));
            assert!(!body.to_string().contains(TOKEN));
        }
    }

    #[tokio::test]
    async fn portable_report_modules_are_public_embedded_and_uncached() {
        let app_script = request("/assets/app.js", None).await;
        let csp = app_script.headers()["content-security-policy"].clone();
        for (path, expected) in [
            (
                "/assets/report-export.js",
                include_str!("../../web/report-export.js"),
            ),
            (
                "/assets/report-bundle.js",
                include_str!("../../web/report-bundle.js"),
            ),
        ] {
            for authorization in [None, Some("Bearer wrong")] {
                let response = request(path, authorization).await;
                assert_eq!(response.status(), StatusCode::OK, "{path}");
                assert_eq!(
                    response.headers()["content-type"],
                    "text/javascript; charset=utf-8"
                );
                assert_eq!(response.headers()["cache-control"], "no-store");
                assert_eq!(response.headers()["content-security-policy"], csp);
                assert_eq!(response.headers()["x-content-type-options"], "nosniff");
                assert_eq!(response.headers()["referrer-policy"], "no-referrer");
                assert!(
                    !response
                        .headers()
                        .contains_key("access-control-allow-origin")
                );
                let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
                    .await
                    .unwrap();
                assert_eq!(bytes.as_ref(), expected.as_bytes(), "{path}");
                assert!(!expected.contains(TOKEN));
            }
        }
    }

    #[tokio::test]
    async fn liveness_does_not_claim_database_or_model_readiness() {
        let response = request("/healthz", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["service"], "scout-api");
        assert!(body.get("models_connected").is_none());
    }

    #[tokio::test]
    async fn data_routes_require_the_local_token_before_database_access() {
        for path in [
            "/readyz",
            "/v1/runs",
            "/v1/runs/00000000-0000-4000-8000-000000000003",
            "/v1/runs/00000000-0000-4000-8000-000000000003/graph",
            "/v1/captures/00000000-0000-4000-8000-000000000004",
            "/v1/captures/00000000-0000-4000-8000-000000000004/image",
            "/v1/artifacts/00000000-0000-4000-8000-000000000004/content",
            "/v1/operations",
            "/v1/browser-jobs",
            "/v1/exploration-settings",
            "/v1/browser-access",
            "/v1/browser-access/00000000-0000-4000-8000-000000000005/screen",
            "/v1/capabilities",
            "/v1/model-providers",
            "/v1/usage",
            "/v1/model-requests/00000000-0000-4000-8000-000000000005",
        ] {
            assert_eq!(request(path, None).await.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(
                request(path, Some("Bearer wrong")).await.status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }

    #[tokio::test]
    async fn unavailable_database_is_explicit() {
        let response = request("/v1/runs", Some(&format!("Bearer {TOKEN}"))).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }

    #[tokio::test]
    async fn editing_exploration_settings_is_authenticated_and_needs_the_durable_queue() {
        for (authorization, expected) in [
            (None, StatusCode::UNAUTHORIZED),
            (
                Some(format!("Bearer {TOKEN}")),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let app = router(AppState::new(None, TOKEN).unwrap());
            let mut builder = Request::builder()
                .method("POST")
                .uri("/v1/exploration-settings")
                .header("content-type", "application/json");
            if let Some(token) = authorization {
                builder = builder.header("authorization", token);
            }
            let response = app
                .oneshot(builder.body(Body::from("{}")).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn automatic_reproduction_cancellation_requires_authentication_and_queue() {
        let path = "/v1/runs/00000000-0000-4000-8000-000000000003/automatic-reproductions/cancel";
        for (authorization, expected) in [
            (None, StatusCode::UNAUTHORIZED),
            (
                Some(format!("Bearer {TOKEN}")),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let app = router(AppState::new(None, TOKEN).unwrap());
            let mut builder = Request::builder().method("POST").uri(path);
            if let Some(token) = authorization {
                builder = builder.header("authorization", token);
            }
            let response = app
                .oneshot(builder.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn invalid_ids_do_not_reach_the_database() {
        assert_eq!(
            request("/v1/runs/not-a-uuid", Some(&format!("Bearer {TOKEN}")))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn weak_or_malformed_tokens_are_rejected() {
        assert!(AppState::new(None, "short").is_err());
        assert!(AppState::new(None, &" ".repeat(64)).is_err());
    }
}
