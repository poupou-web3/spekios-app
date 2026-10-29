//! Durable, revision-checked testing focus. Applied means a planning request
//! includes the instruction; it never changes an already dispatched action.
use crate::{error, identity::ScopedState, query};
use axum::{
    Json,
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Submission {
    pub steering_id: Uuid,
    pub expected_revision: i32,
    pub focus: String,
}

impl Submission {
    fn normalize(&mut self) -> Result<(), &'static str> {
        self.focus = self.focus.trim().to_owned();
        if self.steering_id.is_nil()
            || !(0..=32).contains(&self.expected_revision)
            || self.focus.chars().count() > 2000
            || self
                .focus
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("invalid_steering_request");
        }
        Ok(())
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub offset: Option<i32>,
    pub limit: Option<i32>,
}

pub async fn get(
    ScopedState(state): ScopedState,
    Path(id): Path<Uuid>,
    Query(page): Query<Page>,
) -> Response {
    let offset = page.offset.unwrap_or(0);
    let limit = page.limit.unwrap_or(8);
    if !(0..=32).contains(&offset) || !(1..=8).contains(&limit) {
        return error(StatusCode::BAD_REQUEST, "invalid_steering_page");
    }
    match query(&state, "SELECT scout_steering_snapshot(run_id,$4,$5) FROM runtime_runs WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3", &[&id,&state.principal.workspace_id,&state.principal.user_id,&offset,&limit]).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND,"run_not_found"),
        Err(response) => response,
    }
}

pub async fn submit(
    ScopedState(state): ScopedState,
    Path(id): Path<Uuid>,
    Json(mut input): Json<Submission>,
) -> Response {
    if let Err(code) = input.normalize() {
        return error(StatusCode::UNPROCESSABLE_ENTITY, code);
    }
    let Some(queue) = state.jobs.as_ref() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "browser_queue_unavailable");
    };
    match queue.submit_steering(id, &input).await {
        Ok(value) => match value["error"].as_str() {
            Some(code) => error(
                if code == "run_not_found" {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::CONFLICT
                },
                code,
            ),
            None => Json(value).into_response(),
        },
        Err(code) => error(StatusCode::SERVICE_UNAVAILABLE, code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use serde_json::json;
    use tower::ServiceExt;

    #[tokio::test]
    async fn authentication_and_strict_input_validation_precede_storage() {
        const TOKEN: &str = "fixture_steering_auth_token_00000001";
        for (authorized, body, expected) in [
            (false, json!({}), StatusCode::UNAUTHORIZED),
            (
                true,
                json!({"steering_id":Uuid::new_v4(),"expected_revision":0,"focus":"Search","workspace_id":Uuid::new_v4()}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                true,
                json!({"steering_id":Uuid::nil(),"expected_revision":0,"focus":"Search"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                true,
                json!({"steering_id":Uuid::new_v4(),"expected_revision":0,"focus":"Search"}),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri(format!("/v1/runs/{}/steering", Uuid::new_v4()))
                .header("content-type", "application/json");
            if authorized {
                request = request.header("authorization", format!("Bearer {TOKEN}"));
            }
            let response = crate::router(crate::AppState::new(None, TOKEN).unwrap())
                .oneshot(request.body(Body::from(body.to_string())).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn readonly_agent_cannot_submit_even_through_the_tool_dispatcher() {
        let state = crate::AppState::new(None, "fixture_steering_auth_token_00000001").unwrap();
        let principal = crate::identity::Principal {
            operator: false,
            agent_id: Some(Uuid::new_v4()),
            scopes: vec!["runs:read".into()],
            ..Default::default()
        };
        let result = crate::agent::dispatch(&state.scoped(principal), "scout_steer_run", json!({}))
            .await
            .unwrap();
        assert_eq!(result.structured_content.unwrap()["http_status"], 403);
    }
    #[test]
    fn bounded_focus_allows_clear_and_multiline_but_rejects_controls() {
        let mut s = Submission {
            steering_id: Uuid::new_v4(),
            expected_revision: 0,
            focus: "  Check search\nthen filters  ".into(),
        };
        assert!(s.normalize().is_ok());
        assert_eq!(s.focus, "Check search\nthen filters");
        s.focus = "  ".into();
        assert!(s.normalize().is_ok());
        assert_eq!(s.focus, "");
        for focus in ["x".repeat(2001), "bad\0text".into(), "bad\u{1b}text".into()] {
            s.focus = focus;
            assert!(s.normalize().is_err());
        }
        s.focus = "valid".into();
        s.expected_revision = 33;
        assert!(s.normalize().is_err());
        s.expected_revision = 0;
        s.steering_id = Uuid::nil();
        assert!(s.normalize().is_err());
    }
}
