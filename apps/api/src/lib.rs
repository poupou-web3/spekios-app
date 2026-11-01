use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{StatusCode, uri::Authority},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use uuid::Uuid;
pub mod access;
pub mod agent;
pub mod db;
pub mod gateway;
pub mod history;
pub mod identity;
pub mod issues;
pub mod jobs;
pub mod memory;
use identity::{Principal, ScopedState};
pub mod models;
pub mod oauth;
pub mod reviews;
mod runs;
pub mod steering;
pub mod ui;

/// Legacy local workspace retained for CLI fixtures and operator bootstrap.
/// Model prompts may reach 64 KiB; JSON escaping can roughly double the body.
const MODEL_REQUEST_BODY_LIMIT: usize = 196_608;
pub const WORKSPACE_ID: Uuid = Uuid::from_u128(0x00000000000040008000000000000001);

#[derive(Clone)]
pub struct AppState {
    pub database: Option<Arc<db::Postgres>>,
    pub identities: Option<Arc<identity::Identities>>,
    pub principal: Principal,
    pub gateway: Option<Arc<gateway::Gateway>>,
    pub jobs: Option<Arc<jobs::Queue>>,
    pub reviews: Option<Arc<reviews::Reviews>>,
    bearer: Arc<str>,
    dev_auth_bypass: bool,
    public_origin: Option<Arc<str>>,
}

impl AppState {
    pub fn new(database: Option<Arc<db::Postgres>>, token: &str) -> Result<Self, &'static str> {
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
            identities: None,
            principal: Principal::default(),
            gateway: None,
            jobs: None,
            reviews: None,
            bearer: Arc::from(format!("Bearer {token}")),
            dev_auth_bypass: false,
            public_origin: None,
        })
    }

    pub fn with_public_origin(mut self, raw: Option<&str>) -> Result<Self, &'static str> {
        if let Some(raw) = raw.filter(|value| !value.is_empty()) {
            let url = reqwest::Url::parse(raw)
                .map_err(|_| "SCOUT_PUBLIC_ORIGIN must be a clean HTTPS origin")?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || url.port() == Some(0)
            {
                return Err("SCOUT_PUBLIC_ORIGIN must be a clean HTTPS origin");
            }
            self.public_origin = Some(Arc::from(url.origin().ascii_serialization()));
            self.dev_auth_bypass = false;
        }
        Ok(self)
    }

    pub fn scoped(&self, principal: Principal) -> Self {
        let mut scoped = self.clone();
        scoped.jobs = self.jobs.as_ref().map(|q| Arc::new(q.scoped(&principal)));
        scoped.principal = principal;
        scoped
    }

    /// Explicit local-development convenience. Worker and CLI bearer
    /// authentication remains available and the token is still required.
    pub fn with_dev_auth_bypass(mut self, enabled: bool) -> Self {
        self.dev_auth_bypass = enabled && self.public_origin.is_none();
        self
    }
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/v1/issues", get(issues::list))
        .route("/v1/issues/{issue_id}", get(issues::detail))
        .route(
            "/v1/issues/{issue_id}/verifications",
            axum::routing::post(issues::submit),
        )
        .route(
            "/v1/issue-verifications/{verification_id}",
            get(issues::verification),
        )
        .route(
            "/v1/issues/{issue_id}/triage",
            axum::routing::post(issues::triage),
        )
        .route("/v1/knowledge", get(issues::knowledge))
        .route("/v1/rechecks", axum::routing::post(issues::recheck))
        .route("/v1/rechecks/{recheck_id}", get(issues::recheck_status))
        .route("/v1/history/sessions", get(history::list))
        .route("/v1/history/domain", get(history::summary))
        .route("/v1/identity", get(identity::whoami))
        .route(
            "/v1/workspaces",
            axum::routing::post(identity::create_workspace),
        )
        .route("/v1/agents", get(identity::agents))
        .route("/v1/oauth/authorizations/{id}", get(oauth::review))
        .route(
            "/v1/oauth/authorizations/{id}/decision",
            axum::routing::post(oauth::decide),
        )
        .route(
            "/v1/agents/{id}/revoke",
            axum::routing::post(identity::revoke),
        )
        .route("/v1/agent-connections/{code}", get(identity::connection))
        .route(
            "/v1/agent-connections/{code}/decision",
            axum::routing::post(identity::decide),
        )
        .route("/readyz", get(ready))
        .route("/v1/runs", get(runs::list))
        .route("/v1/runs/{run_id}", get(runs::get))
        .route("/v1/runs/{run_id}/graph", get(runs::graph))
        .route("/v1/runs/{run_id}/events", get(agent::events))
        .route(
            "/v1/runs/{run_id}/steering",
            get(steering::get).post(steering::submit),
        )
        .route(
            "/v1/runs/{run_id}/progress",
            get(agent::report::run_progress),
        )
        .route(
            "/v1/runs/{run_id}/report",
            get(agent::report::run_report_http),
        )
        .route(
            "/v1/runs/{run_id}/issues/{action_id}",
            get(agent::report::issue_http),
        )
        .route("/v1/agent/tools", get(agent::catalog))
        .route(
            "/v1/agent/tools/{name}",
            axum::routing::post(agent::http_call),
        )
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
        .route("/v1/captures/{capture_id}", get(runs::capture))
        .route("/v1/captures/{capture_id}/image", get(ui::capture_image))
        .route("/v1/artifacts/{artifact_id}/content", get(ui::artifact))
        .route("/v1/operations", get(ui::operations))
        .route("/v1/browser-jobs", get(jobs::list).post(jobs::submit))
        .route("/v1/browser-jobs/{job_id}", get(jobs::get_job))
        .route(
            "/v1/browser-jobs/{job_id}/progress",
            get(agent::report::job_progress),
        )
        .route(
            "/v1/browser-jobs/{job_id}/report",
            get(agent::report::job_report),
        )
        .route(
            "/v1/exploration-settings",
            get(jobs::exploration_settings).post(jobs::save_exploration_settings),
        )
        .route(
            "/v1/browser-jobs/{job_id}/cancel",
            axum::routing::post(jobs::cancel_job),
        )
        .route("/v1/app-memory", get(memory::list))
        .route("/v1/app-memory/{scope_id}/map", get(memory::map))
        .route("/v1/runs/{run_id}/map-diff", get(memory::compare))
        .route(
            "/v1/app-memory/{scope_id}/forget",
            axum::routing::post(memory::forget),
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
        .route(
            "/v1/model-requests",
            axum::routing::post(gateway::submit).layer(axum::extract::DefaultBodyLimit::max(
                MODEL_REQUEST_BODY_LIMIT,
            )),
        )
        .route("/v1/model-requests/{request_id}", get(gateway::request))
        .route("/v1/usage", get(gateway::usage_report))
        .layer(axum::extract::DefaultBodyLimit::max(65_536))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize));
    let mcp = Router::new()
        .route_service("/mcp", agent::service(state.clone()))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize_mcp));
    Router::new()
        .route("/", get(ui::index))
        .route("/favicon.svg", get(ui::favicon))
        .route("/connect", get(ui::connect))
        .route("/issues", get(ui::issues))
        .route("/v1/agent-setup", get(oauth::setup))
        .route("/.well-known/oauth-protected-resource", get(oauth::resource_metadata))
        .route("/.well-known/oauth-protected-resource/mcp", get(oauth::resource_metadata))
        .route("/.well-known/oauth-authorization-server", get(oauth::server_metadata))
        .route("/oauth/register", axum::routing::post(oauth::register))
        .route("/oauth/authorize", get(oauth::authorize))
        .route("/oauth/token", axum::routing::post(oauth::token))
        .route("/oauth/revoke", axum::routing::post(oauth::revoke))
        .route("/v1/agent-connections", axum::routing::post(identity::begin))
        .route("/v1/agent-connections/token", axum::routing::post(identity::poll))
        .layer(axum::extract::DefaultBodyLimit::max(65_536))
        .route("/assets/{*path}", get(ui::asset_file))
        .route("/v1/auth-mode", get(auth_mode))
        .route("/healthz", get(|| async { Json(json!({"status":"ok","service":"scout-api","version":env!("CARGO_PKG_VERSION")})) }))
        .merge(protected)
        .merge(mcp)
        .layer(middleware::from_fn(no_store))
        .with_state(state)
}

// Every request, including stateless MCP messages, resolves its own principal.
async fn authorize_mcp(State(state): State<AppState>, request: Request, next: Next) -> Response {
    authorize_request(state, request, next, false).await
}
async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    authorize_request(state, request, next, true).await
}
async fn authorize_request(
    state: AppState,
    mut request: Request,
    next: Next,
    allow_dev: bool,
) -> Response {
    let approval_mutation = request.method() == axum::http::Method::POST
        && (request.uri().path().starts_with("/v1/agent-connections/")
            || request
                .uri()
                .path()
                .starts_with("/v1/oauth/authorizations/")
            || request.uri().path().starts_with("/v1/agents/")
            || request.uri().path() == "/v1/workspaces");
    if (!allow_dev || approval_mutation)
        && (request.headers().contains_key("origin")
            || request.headers().contains_key("sec-fetch-site"))
        && !local_development_request(&request)
        && !configured_browser_request(&state, &request)
    {
        return error(StatusCode::FORBIDDEN, "request_origin_not_allowed");
    }
    let count = request.headers().get_all("authorization").iter().count();
    let presented = request
        .headers()
        .get("authorization")
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    let operator_token = count == 1 && bool::from(presented.ct_eq(state.bearer.as_bytes()));
    let local_preview =
        count == 0 && allow_dev && state.dev_auth_bypass && local_development_request(&request);
    let principal = if operator_token || local_preview {
        Some(Principal::default())
    } else if count == 1 {
        if let Some(token) = request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            && token.len() <= 256
            && token.starts_with("scout_")
        {
            match &state.identities {
                Some(store) => match store.authenticate(token).await {
                    Ok(p) => p,
                    Err(_) => {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "identity_store_unavailable",
                        );
                    }
                },
                None => None,
            }
        } else {
            None
        }
    } else {
        None
    };
    let Some(principal) = principal else {
        let mut response = error(StatusCode::UNAUTHORIZED, "unauthorized");
        response.headers_mut().insert(
            "www-authenticate",
            oauth::challenge(&state, request.headers(), request.uri().path()),
        );
        response
            .headers_mut()
            .insert("cache-control", "no-store".parse().unwrap());
        return response;
    };
    if let Some(audience) = &principal.audience {
        let resource =
            oauth::origin(&state, request.headers()).map(|origin| format!("{origin}/mcp"));
        if request.uri().path() != "/mcp" || resource.as_ref() != Some(audience) {
            let mut response = error(StatusCode::UNAUTHORIZED, "invalid_token_audience");
            response.headers_mut().insert(
                "www-authenticate",
                oauth::challenge(&state, request.headers(), request.uri().path()),
            );
            return response;
        }
    }
    let permitted =
        identity::permitted(&principal, request.method().as_str(), request.uri().path());
    // Only route templates and status enter this audit. No query strings,
    // Authorization headers, private browser inputs or model payloads.
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|p| p.as_str())
        .unwrap_or("unknown");
    let operation = format!("{} {}", request.method(), route);
    if let Some(store) = &state.identities
        && store
            .audit(&principal, &operation, "started")
            .await
            .is_err()
    {
        return error(StatusCode::SERVICE_UNAVAILABLE, "audit_unavailable");
    }
    request
        .extensions_mut()
        .insert(state.scoped(principal.clone()));
    let mut response = if permitted {
        next.run(request).await
    } else {
        error(StatusCode::FORBIDDEN, "insufficient_scope")
    };
    if let Some(store) = &state.identities {
        // Admission metadata is fail-closed; read completion audit failures are
        // surfaced without replaying or pretending a mutation was rolled back.
        if store
            .audit(
                &principal,
                &operation,
                &response.status().as_u16().to_string(),
            )
            .await
            .is_err()
        {
            response.headers_mut().insert(
                "x-scout-audit-status",
                "completion-unavailable".parse().unwrap(),
            );
        }
    }
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
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

// A reverse proxy's forwarded headers do not enroll a browser origin. Only the
// operator's explicit HTTPS origin can enable same-origin approval remotely.
fn configured_browser_request(state: &AppState, request: &Request) -> bool {
    let Some(origin) = state.public_origin.as_deref() else {
        return false;
    };
    let headers = request.headers();
    if headers.get_all("host").iter().count() != 1
        || headers.get_all("origin").iter().count() != 1
        || headers.get_all("sec-fetch-site").iter().count() > 1
    {
        return false;
    }
    if headers.get("origin").and_then(|v| v.to_str().ok()) != Some(origin) {
        return false;
    }
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| !matches!(v.to_str(), Ok("same-origin" | "none")))
    {
        return false;
    }
    let Ok(expected) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    let Some(expected_authority) = expected.authority() else {
        return false;
    };
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if host.trim() != host || host.contains('@') {
        return false;
    }
    let Ok(authority) = host.parse::<Authority>() else {
        return false;
    };
    let Some(suffix) = host.get(authority.host().len()..) else {
        return false;
    };
    if !suffix.is_empty()
        && !suffix.strip_prefix(':').is_some_and(|port| {
            !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|p| p > 0)
        })
    {
        return false;
    }
    if !same_authority(&authority, expected_authority, "https") {
        return false;
    }
    if request
        .uri()
        .scheme_str()
        .is_some_and(|scheme| scheme != "https")
        || request
            .uri()
            .authority()
            .is_some_and(|host| !same_authority(host, expected_authority, "https"))
    {
        return false;
    }
    true
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
    let read = async {
        let connection = database.read().await.map_err(|_| ())?;
        connection.query_opt(sql, params).await.map_err(|_| ())
    };
    match tokio::time::timeout(Duration::from_secs(5), read).await {
        Ok(Ok(row)) => Ok(row.map(|row| row.get::<_, Value>(0))),
        _ => Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "database_unavailable",
        )),
    }
}

async fn ready(ScopedState(state): ScopedState) -> Response {
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

async fn capabilities(ScopedState(state): ScopedState) -> Response {
    let effective_settings = match &state.jobs {
        Some(queue) => match queue.effective_settings().await {
            Ok(value) => value["settings"].clone(),
            Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
        },
        None => {
            json!({"maxAutoReproductions":2,"maxAutoReplayActions":12,"appMemory":false,"settingsRevision":0})
        }
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
        "bounded_url_exploration":{"entrypoints":["recorder_cli","browser_jobs_api","workspace_ui"],"scope":"public_https_or_allowed_origins","requires_configured_model":true,"coverage_complete":false,
            "interactions":["navigate","click","fill","select","set_checked","scroll","submit"],"interaction_version":"browser-interactions-v2",
            "form_submission":"same_origin_search_or_operator_configured_test_form",
            "action_completion":{"version":"action-completion-v1","timeout_ms":5000,"sampled_frames":true,"network_and_console_evidence":true}},
        "active_run_steering":{"enabled":state.jobs.is_some(),"version":"focus-v1","application_boundary":"next_planning_decision","max_messages":32,"max_focus_characters":2000,"replay_steering":false},
        "persistent_issues":{"enabled":true,"stable_ids":true,"candidate_verification":true,"outcomes":["resolved","still_reproducible","blocked","inconclusive"],"global_fix_claim":false},
        "issue_triage":{"enabled":true,"decisions":issues::TRIAGE_DECISIONS,"actors":["human","agent","system"],"agent_overrides_human":false,"append_only":true,
            "known_behavior_matching":"page_control_viewport_sign_in","suppression":"recorded_and_labelled_never_dropped"},
        "deployment_recheck":{"enabled":state.jobs.is_some(),"max_issues":issues::MAX_RECHECK_ISSUES,"includes":["untriaged","needs_review","bug"],"ci_script":"scripts/scout-recheck.mjs","schedules":false},
        "suspect_reproduction":{"entrypoints":["recorder_cli","browser_jobs_api","workspace_ui"],"fresh_browser":true,"attempts_per_source_action":1,"automatic_confirmation":false},
        "automatic_reproduction":{"enabled":state.jobs.is_some(),"opt_in":true,"recursive":false,"automatic_confirmation":false,"max_cases":effective_settings["maxAutoReproductions"],"max_replay_actions":effective_settings["maxAutoReplayActions"],"durable_cancellation":true},
        "exploration_settings":{"editable":state.jobs.is_some(),"revision":effective_settings["settingsRevision"],"origins_editable":false,"credentials_editable":false},
        "finding_review":{"enabled":state.reviews.is_some(),"append_only":true,"optimistic_concurrency":true,"confirmation_requires_reproduction":true,"training_approval":false},
        "workspace_ui":true,"browser_job_submission":state.jobs.is_some(),
        "agent_interface":{"version":1,"mcp_endpoint":"/mcp","http_catalog":"/v1/agent/tools","stdio_bridge":true,"coding_agent_report":true,"asynchronous_progress":true,"human_review_write":false,"external_browser_driver":false},
        "cancellation":{"queued_jobs":true,"active_explorer_runs":true,"durable":true,"resume":false,"in_flight_provider_calls":"settle_and_account"},
        "browser_isolation":{"sandbox_container":true,"scout_credentials":false,"saved_login_vault":false,"storage_network":false,"chromium_sandbox":"default_on","fresh_container_per_run":true},
        "app_login":{"manual_handoff":true,"session_reuse":true,"saved_session_hours":24,"google_oauth":false,"private_login_recording":false},
        "frontier_planning":{"version":"frontier-v4","strategy":{"version":"strategy-v1","modes":["breadth","depth","rewalk"],"default":jobs::default_strategy(),"configurable_per":["user"],"adaptive_floor":0.25,"max_journey_steps":12,"branch_slack":6},"automatic_return":true,"stale_plan_recovery":true,"local_recovery":true,"max_consecutive_replans_per_page":3,"probability_calibrated":false,
            "max_actions":jobs::MAX_EXPLORATION_ACTIONS,"limits":{"default":"none","configurable_per":["user","project","model"],"keys":jobs::LIMIT_KEYS,"max_minutes":jobs::MAX_EXPLORATION_MINUTES,"default_stop_after_idle_actions":jobs::DEFAULT_IDLE_ACTIONS,"usage_limits_count":"settled_reported_usage"},"document_controls":true,"reveal_before_action":true,"max_observed_controls":120,"max_prompt_bytes":65536,"max_duration_minutes_env":"SCOUT_EXPLORER_MAX_MINUTES"},
        "model_cost":{"ranking_reuse":{"version":"ranking-v1","enabled_by_default":effective_settings["reuseRankings"],"requires":"app_memory","max_reuses":10,"skipped_when":["testing_focus","screen_changed","fill_proposals","truncated_controls"]},
            "navigation_model":{"configured":effective_settings["navigationModel"],"actions":["navigate","link_click","scroll"],"reassess_with_main_model":["not_no_issue_observed","expectation_uncertain","browser_diagnostics","navigation_model_failed"]}},
        "app_memory":{"version":"app-memory-v1","enabled_by_default":effective_settings["appMemory"],"scope":["origin","viewport_profile","auth_scope","execution_mode"],"keyed_by":"url_and_control_identity","resume_remembered_pages":true,"replays_use_memory":false,"forget":"/v1/app-memory/{scope_id}/forget"},
        "viewport_profiles":["desktop","tablet","mobile"],
        "model_gateway":true,"model_inference":configured && state.gateway.as_ref().is_some_and(|g|g.is_ready()),
        "model_providers":providers,
        "authentication":"workspace_bound_credentials", "workspace_id":state.principal.workspace_id.to_string()
    })).into_response()
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
    async fn configured_https_origin_enables_approval_but_never_anonymous_development_access() {
        for raw in [
            "http://scout.example",
            "https://user:secret@scout.example",
            "https://scout.example/path",
            "https://scout.example?token=x",
        ] {
            assert!(
                AppState::new(None, TOKEN)
                    .unwrap()
                    .with_public_origin(Some(raw))
                    .is_err()
            );
        }
        let configured = AppState::new(None, TOKEN)
            .unwrap()
            .with_public_origin(Some("https://scout.example"))
            .unwrap()
            .with_dev_auth_bypass(true);
        assert!(
            !configured.dev_auth_bypass,
            "A configured public origin cannot use the local anonymous bypass"
        );
        for (authorization, origin, host, expected) in [
            (
                true,
                "https://scout.example",
                "scout.example",
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                false,
                "https://scout.example",
                "scout.example",
                StatusCode::UNAUTHORIZED,
            ),
            (
                true,
                "https://foreign.example",
                "scout.example",
                StatusCode::FORBIDDEN,
            ),
            (
                true,
                "https://scout.example",
                "foreign.example",
                StatusCode::FORBIDDEN,
            ),
            (
                true,
                "https://scout.example",
                "scout.example:bogus",
                StatusCode::FORBIDDEN,
            ),
        ] {
            let app = router(
                AppState::new(None, TOKEN)
                    .unwrap()
                    .with_dev_auth_bypass(true)
                    .with_public_origin(Some("https://scout.example/"))
                    .unwrap(),
            );
            let mut request = Request::builder()
                .method("POST")
                .uri("/v1/agent-connections/AAAAAAAAAAAA/decision")
                .header("host", host)
                .header("origin", origin)
                .header("sec-fetch-site", "same-origin")
                .header("content-type", "application/json");
            if authorization {
                request = request.header("authorization", format!("Bearer {TOKEN}"));
            }
            assert_eq!(
                app.oneshot(request.body(Body::from(r#"{"approve":true}"#)).unwrap())
                    .await
                    .unwrap()
                    .status(),
                expected,
                "{host} {origin}"
            );
        }
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
    async fn browser_modules_are_public_embedded_and_uncached() {
        let entry = request("/assets/app/main.js", None).await;
        let csp = entry.headers()["content-security-policy"].clone();
        for required in [
            "app/main.js",
            "app/connect.js",
            "app/issues.js",
            "app/report/bundle.js",
            "app/styles/workspace.css",
            "ui/http.js",
            "ui/theme-init.js",
            "ui/styles/tokens.css",
        ] {
            assert!(
                ui::ASSETS.iter().any(|(path, _, _)| *path == required),
                "{required}"
            );
        }
        assert!(
            !ui::ASSETS
                .iter()
                .any(|(path, _, _)| path.contains("backoffice")
                    || path.contains(".test.")
                    || path.contains("testing/"))
        );
        for (asset, content_type, expected) in ui::ASSETS {
            let path = format!("/assets/{asset}");
            for authorization in [None, Some("Bearer wrong")] {
                let response = request(&path, authorization).await;
                assert_eq!(response.status(), StatusCode::OK, "{path}");
                assert_eq!(response.headers()["content-type"], *content_type);
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
        for path in [
            "/assets/.env",
            "/assets/app/../../.env",
            "/assets/%2e%2e%2f.env",
            "/assets/app/%2e%2e/test/support.mjs",
            "/assets/ui/../testing/link.mjs",
            "/assets/backoffice/main.js",
            "/assets/app.js",
        ] {
            assert_eq!(
                request(path, None).await.status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
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
