//! Agent dashboard reads over the complete private run history, not latest-50.
use crate::{AppState, error, identity::ScopedState, query};
use axum::{
    Json,
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    pub domain: Option<String>,
    pub url: Option<String>,
    pub project_id: Option<Uuid>,
    pub task_id: Option<Uuid>,
    pub agent_id: Option<Uuid>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}
impl Filters {
    fn normalize(&mut self) -> Result<(), &'static str> {
        if let Some(domain) = &self.domain {
            if domain.len() > 253
                || domain.contains(['/', '?', '#', '@', '%'])
                || (domain.contains(':') && !(domain.starts_with('[') && domain.ends_with(']')))
            {
                return Err("invalid_history_domain");
            }
            let url = reqwest::Url::parse(&format!("https://{domain}"))
                .map_err(|_| "invalid_history_domain")?;
            if url.port().is_some() || url.host_str().is_none() {
                return Err("invalid_history_domain");
            }
            self.domain = url.host_str().map(str::to_owned);
        }
        if let Some(raw) = &self.url {
            let url = reqwest::Url::parse(raw).map_err(|_| "invalid_history_url")?;
            if raw.len() > 2048
                || !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("invalid_history_url");
            }
            self.url = Some(url.to_string());
        }
        if self.offset.is_some_and(|v| !(0..=100000).contains(&v))
            || self.limit.is_some_and(|v| !(1..=50).contains(&v))
            || [self.project_id, self.task_id, self.agent_id]
                .iter()
                .flatten()
                .any(Uuid::is_nil)
        {
            return Err("invalid_history_pagination_or_id");
        }
        Ok(())
    }
}
pub async fn sessions(state: &AppState, mut filters: Filters) -> Response {
    if let Err(code) = filters.normalize() {
        return error(StatusCode::BAD_REQUEST, code);
    }
    let offset = filters.offset.unwrap_or(0);
    let limit = filters.limit.unwrap_or(20);
    // Correlation IDs never grant access. Both the run and linked admission must
    // match the caller's workspace and canonical dataset owner.
    let sql="WITH matching AS (
        SELECT r.*,j.job_id,j.agent_id,j.project_id,j.task_id FROM runtime_runs r
        LEFT JOIN LATERAL (SELECT job_id,agent_id,project_id,task_id FROM browser_jobs j WHERE j.run_id=r.run_id AND j.workspace_id=r.workspace_id AND j.user_id=r.user_id ORDER BY j.created_at,j.job_id LIMIT 1) j ON true
        WHERE r.workspace_id=$1 AND r.user_id=$2
          AND ($3::text IS NULL OR lower(substring(r.target_url from '^[a-zA-Z][a-zA-Z0-9+.-]*://(\\[[^]]+\\]|[^/:?#]+)'))=$3)
          AND ($4::text IS NULL OR r.target_url=$4)
          AND ($5::uuid IS NULL OR j.project_id=$5) AND ($6::uuid IS NULL OR j.task_id=$6) AND ($7::uuid IS NULL OR j.agent_id=$7)
      ), page AS (SELECT * FROM matching ORDER BY created_at DESC,run_id DESC OFFSET $8 LIMIT $9)
      SELECT jsonb_build_object('visibility','team_private','workspace_id',$1::uuid,'total',(SELECT count(*) FROM matching),'sessions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'run_id',r.run_id,'job_id',r.job_id,'agent_id',r.agent_id,'project_id',r.project_id,'task_id',r.task_id,'url',r.target_url,'lifecycle',r.lifecycle,'created_at',r.created_at,'finished_at',r.finished_at,
        'viewport_profile',r.config->'viewport_profile','execution_mode',r.config->'execution_mode','coverage_complete',false,
        'actions',(SELECT count(*) FROM runtime_actions a WHERE a.run_id=r.run_id),
        'candidates',(SELECT count(*) FROM runtime_actions a WHERE a.run_id=r.run_id AND a.assessment->>'verdict'='suspect'),
        'known_input_tokens',(SELECT sum(c.input_tokens) FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=r.run_id AND m.workspace_id=$1 AND m.user_id=$2),
        'known_output_tokens',(SELECT sum(c.output_tokens) FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=r.run_id AND m.workspace_id=$1 AND m.user_id=$2),
        'known_total_tokens',(SELECT CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=r.run_id AND m.workspace_id=$1 AND m.user_id=$2),
        'report',jsonb_build_object('tool','scout_get_report','arguments',jsonb_build_object('run_id',r.run_id))) ORDER BY r.created_at DESC,r.run_id DESC) FROM page r),'[]'::jsonb))";
    match query(
        state,
        sql,
        &[
            &state.principal.workspace_id,
            &state.principal.user_id,
            &filters.domain,
            &filters.url,
            &filters.project_id,
            &filters.task_id,
            &filters.agent_id,
            &offset,
            &limit,
        ],
    )
    .await
    {
        Ok(Some(mut value)) => {
            let total = value["total"].as_i64().unwrap_or(0);
            let returned = value["sessions"].as_array().map_or(0, Vec::len) as i64;
            value["pagination"] = json!({"offset":offset,"limit":limit,"next_offset":if offset+returned<total {Some(offset+returned)}else{None},"ordering":"created_at_desc_run_id_desc","snapshot_frozen":false});
            value["filters"] = json!({"domain":filters.domain,"url":filters.url,"project_id":filters.project_id,"task_id":filters.task_id,"agent_id":filters.agent_id});
            Json(value).into_response()
        }
        Ok(None) => Json(json!({"sessions":[]})).into_response(),
        Err(r) => r,
    }
}
pub async fn list(ScopedState(state): ScopedState, Query(filters): Query<Filters>) -> Response {
    sessions(&state, filters).await
}
pub async fn domain_summary(state: &AppState, filters: Filters) -> Response {
    if filters.domain.is_none() {
        return error(StatusCode::BAD_REQUEST, "domain_required");
    }
    // The list and total cover all matching history. This digest explicitly
    // describes its bounded sample; past observations are never fresh checks.
    let response = sessions(
        state,
        Filters {
            limit: Some(20),
            offset: Some(0),
            ..filters
        },
    )
    .await;
    let status = response.status();
    let Ok(bytes) = axum::body::to_bytes(response.into_body(), 128 * 1024).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "history_result_too_large");
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "invalid_history_result");
    };
    if status.is_success() {
        value["summary_scope"] = json!({"sample":"latest_20_matching_runs","historical_only":true,"coverage_complete":false,"guidance":"Use stored reports as planning context. Verify the current deployment before treating old findings as current bugs."});
    }
    (status, Json(value)).into_response()
}
pub async fn summary(ScopedState(state): ScopedState, Query(filters): Query<Filters>) -> Response {
    domain_summary(&state, filters).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_domain_filters_cannot_become_urls_or_ownership_overrides() {
        for value in [
            "example.com/path",
            "example.com:443",
            "user@example.com",
            "example.com?x=1",
            "example.com#x",
            "example.com/%2f",
        ] {
            assert!(
                Filters {
                    domain: Some(value.into()),
                    ..Filters::default()
                }
                .normalize()
                .is_err(),
                "{value}"
            );
        }
        let mut filter = Filters {
            domain: Some("EXAMPLE.COM".into()),
            ..Filters::default()
        };
        filter.normalize().unwrap();
        assert_eq!(filter.domain.as_deref(), Some("example.com"));
        assert!(serde_json::from_value::<Filters>(json!({"workspace_id":Uuid::new_v4()})).is_err());
        assert!(
            Filters {
                limit: Some(51),
                ..Filters::default()
            }
            .normalize()
            .is_err()
        );
    }
}
