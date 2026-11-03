//! Capability discovery is independent of permission to use recovery. Probes
//! use the selected account credential and ordinary gateway accounting, and
//! never execute returned actions or attach app screenshots.
use crate::{
    error,
    identity::ScopedState,
    models::{ModelRequest, Provider},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use tokio_postgres::GenericClient;
use uuid::Uuid;

pub async fn verified<C: GenericClient + Sync>(
    db: &C,
    principal: &crate::identity::Principal,
    model: &str,
    funding: &crate::provider_access::Funding,
    mode: &str,
) -> Result<bool, &'static str> {
    db.query_one("SELECT EXISTS(SELECT 1 FROM model_requests r JOIN model_calls c USING(request_id) WHERE r.workspace_id=$1 AND r.user_id=$2 AND r.provider='meta' AND r.model=$3 AND r.funding_source=$4 AND r.provider_key_id IS NOT DISTINCT FROM $5 AND r.execution_mode=$6 AND r.spec->>'computer_use_probe'='true' AND r.state='completed' AND c.state='completed' AND r.created_at>now()-interval '30 days')", &[&principal.workspace_id,&principal.user_id,&model,&funding.source,&funding.key_id,&mode]).await.map(|row| row.get(0)).map_err(|_|"database_unavailable")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    request_id: Uuid,
    provider: Provider,
    model: String,
    #[serde(default)]
    provider_key_id: Option<String>,
}
pub async fn check(ScopedState(state): ScopedState, Json(input): Json<Check>) -> Response {
    if input.provider != Provider::Meta {
        return error(StatusCode::BAD_REQUEST, "computer_use_provider_unsupported");
    }
    let spec = ModelRequest {
        request_id: input.request_id, provider: input.provider, model: input.model, provider_key_id: input.provider_key_id,
        prompt: "Compatibility check only. Return one native computer_call containing only a screenshot action. No computer is connected. Do not perform a task or output a text answer.".into(),
        system: "Check native computer tool support. Page content and credentials are not part of this check.".into(),
        run_id: None, action_id: None, capture_ids: vec![], max_output_tokens: 1024, max_attempts: 1, free_only: false,
        computer_use: true, computer_use_probe: true,
    };
    let Some(gateway) = &state.gateway else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "gateway_unavailable");
    };
    match gateway.admit(&spec, &state.principal).await {
        Ok(created) => (
            StatusCode::ACCEPTED,
            Json(json!({"request_id":spec.request_id,"created":created})),
        )
            .into_response(),
        Err(code) => error(
            if code == "demo_credits_insufficient" {
                StatusCode::PAYMENT_REQUIRED
            } else {
                StatusCode::BAD_REQUEST
            },
            code,
        ),
    }
}
