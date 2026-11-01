//! Cross-run exploration memory: list remembered app scopes, read an app's
//! map, compare a run with earlier runs and forget a scope. Memory is a
//! derived projection of runs; forgetting never removes evidence.
use crate::{AppState, error, identity::ScopedState, query};
use axum::{
    Json,
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

const MAX_RESPONSE: usize = 128 * 1024;

pub async fn list(ScopedState(state): ScopedState) -> Response {
    let sql = "SELECT jsonb_build_object('scopes',COALESCE(jsonb_agg(item ORDER BY updated_at DESC,scope_id),'[]'::jsonb),'limit',100) FROM (
      SELECT s.updated_at,s.scope_id,jsonb_build_object('scope_id',s.scope_id,'origin',s.origin,'viewport_profile',s.viewport_profile,
        'viewport',jsonb_build_object('width',s.viewport_width,'height',s.viewport_height),
        'auth_scope',s.auth_scope,'execution_mode',s.execution_mode,'runs',s.runs,'last_run_id',s.last_run_id,
        'created_at',s.created_at,'updated_at',s.updated_at,
        'pages',(SELECT count(*) FROM app_memory_pages p WHERE p.scope_id=s.scope_id),
        'controls',(SELECT count(*) FROM app_memory_controls c WHERE c.scope_id=s.scope_id),
        'tried_controls',(SELECT count(*) FROM app_memory_controls c WHERE c.scope_id=s.scope_id AND c.attempts>0),
        'untried_controls',(SELECT count(*) FROM app_memory_controls c WHERE c.scope_id=s.scope_id AND c.attempts=0 AND c.blocked_reason IS NULL),
        'map_states',(SELECT count(*) FROM app_map_states m WHERE m.scope_id=s.scope_id),
        'map_transitions',(SELECT count(*) FROM app_map_transitions t WHERE t.scope_id=s.scope_id),
        'map_max_depth',(SELECT max(min_depth) FROM app_map_states m WHERE m.scope_id=s.scope_id),
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

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapQuery {
    pub scope_id: Option<Uuid>,
    pub origin: Option<String>,
    pub viewport_profile: Option<String>,
    pub auth_scope: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

/// The app map of one scope: states by depth from the entry page, what each
/// leads to, and the controls no run has tried there yet.
pub(crate) async fn read_map(state: &AppState, filters: MapQuery) -> Response {
    let (offset, limit) = (filters.offset.unwrap_or(0), filters.limit.unwrap_or(20));
    if !(0..=100_000).contains(&offset)
        || !(1..=100).contains(&limit)
        || filters
            .viewport_profile
            .as_deref()
            .is_some_and(|v| !matches!(v, "desktop" | "tablet" | "mobile"))
        || filters
            .auth_scope
            .as_deref()
            .is_some_and(|v| !matches!(v, "public" | "signed_in"))
        || filters.origin.as_deref().is_some_and(|o| o.len() > 2048)
        || filters.scope_id.is_none() == filters.origin.is_none()
    {
        return error(StatusCode::BAD_REQUEST, "invalid_app_map_request");
    }
    let origin = match filters.origin.as_deref().map(reqwest::Url::parse) {
        Some(Ok(url)) => Some(url.origin().ascii_serialization()),
        Some(Err(_)) => return error(StatusCode::BAD_REQUEST, "invalid_app_map_request"),
        None => None,
    };
    let sql = "WITH scope AS (SELECT * FROM app_memory_scopes s WHERE s.workspace_id=$1 AND s.user_id=$2
        AND ($3::uuid IS NULL OR s.scope_id=$3) AND ($4::text IS NULL OR s.origin=$4)
        AND ($5::text IS NULL OR s.viewport_profile=$5) AND ($6::text IS NULL OR s.auth_scope=$6) ORDER BY s.updated_at DESC LIMIT 1),
      page AS (SELECT st.* FROM app_map_states st JOIN scope USING(scope_id) ORDER BY st.min_depth,st.page_template,st.state_key OFFSET $7 LIMIT $8),
      untried AS (SELECT st.state_key,c.value AS control FROM app_map_states st JOIN scope USING(scope_id) CROSS JOIN jsonb_array_elements(st.controls) c
        WHERE NOT EXISTS(SELECT 1 FROM app_map_transitions t WHERE t.scope_id=st.scope_id AND t.from_key=st.state_key AND t.entry_key=c.value->>'key'))
      SELECT jsonb_build_object('scope',(SELECT to_jsonb(scope)-'workspace_id'-'user_id' FROM scope),
        'summary',jsonb_build_object('states',(SELECT count(*) FROM app_map_states WHERE scope_id=(SELECT scope_id FROM scope)),
          'page_templates',(SELECT count(DISTINCT page_template) FROM app_map_states WHERE scope_id=(SELECT scope_id FROM scope)),
          'transitions',(SELECT count(*) FROM app_map_transitions WHERE scope_id=(SELECT scope_id FROM scope)),
          'max_depth',(SELECT max(min_depth) FROM app_map_states WHERE scope_id=(SELECT scope_id FROM scope)),
          'suspect_transitions',(SELECT count(*) FROM app_map_transitions WHERE scope_id=(SELECT scope_id FROM scope) AND last_verdict='suspect'),
          'untried_controls',(SELECT count(*) FROM untried),
          -- Coverage at each depth across runs: control entries acted on in any run.
          'by_depth',COALESCE((SELECT jsonb_agg(jsonb_build_object('depth',d.min_depth,'states',d.states,'controls',d.controls,'tried',d.controls-d.untried,
              'coverage',CASE WHEN d.controls>0 THEN round((d.controls-d.untried)::numeric/d.controls,3) ELSE 1 END) ORDER BY d.min_depth)
            FROM (SELECT st.min_depth,count(*) AS states,sum(jsonb_array_length(st.controls)) AS controls,
                (SELECT count(*) FROM untried u JOIN app_map_states x ON x.state_key=u.state_key AND x.scope_id=(SELECT scope_id FROM scope) WHERE x.min_depth=st.min_depth) AS untried
              FROM app_map_states st JOIN scope USING(scope_id) GROUP BY st.min_depth) d),'[]'::jsonb)),
        'states',COALESCE((SELECT jsonb_agg(jsonb_build_object('state_key',p.state_key,'page_template',p.page_template,'example_url',p.example_url,'title',p.title,
            'depth',p.min_depth,'runs',p.runs,'observations',p.observations,'first_seen_at',p.first_seen_at,'last_seen_at',p.last_seen_at,
            'controls',jsonb_array_length(p.controls),'controls_truncated',p.controls_truncated,
            'untried_controls',(SELECT count(*) FROM untried u WHERE u.state_key=p.state_key),
            'untried_sample',(SELECT COALESCE(jsonb_agg(u.control-'key'),'[]'::jsonb) FROM (SELECT control FROM untried u WHERE u.state_key=p.state_key ORDER BY control->>'key' LIMIT 12) u),
            'transitions',(SELECT COALESCE(jsonb_agg(jsonb_build_object('action',t.action,'control',t.control,'to_state_key',t.to_key,
                'to_page_template',(SELECT page_template FROM app_map_states d WHERE d.scope_id=t.scope_id AND d.state_key=t.to_key),
                'attempts',t.attempts,'verdicts',t.verdicts,'last_verdict',t.last_verdict,'last_observed_result',t.last_observed_result,
                'last_run_id',t.last_run_id,'last_action_id',t.last_action_id,'last_seen_at',t.last_seen_at) ORDER BY t.last_seen_at DESC),'[]'::jsonb)
              FROM (SELECT * FROM app_map_transitions t WHERE t.scope_id=p.scope_id AND t.from_key=p.state_key ORDER BY t.last_seen_at DESC LIMIT 40) t))
          ORDER BY p.min_depth,p.page_template,p.state_key) FROM page p),'[]'::jsonb),
        'offset',$7::bigint,'limit',$8::bigint,
        'next_offset',CASE WHEN (SELECT count(*) FROM app_map_states WHERE scope_id=(SELECT scope_id FROM scope))>$7+$8 THEN $7+$8 END,
        'identity','A state is a page template (identifiers become :n or :id) plus the controls it offers, with repeated list items collapsed. Exact screens stay per-run evidence.',
        'untrusted_app_content',true)
      WHERE EXISTS(SELECT 1 FROM scope)";
    match query(
        state,
        sql,
        &[
            &state.principal.workspace_id,
            &state.principal.user_id,
            &filters.scope_id,
            &origin,
            &filters.viewport_profile,
            &filters.auth_scope,
            &offset,
            &limit,
        ],
    )
    .await
    {
        Ok(Some(v)) if v.to_string().len() <= MAX_RESPONSE => Json(v).into_response(),
        Ok(Some(_)) => error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "app_map_page_too_large_reduce_limit",
        ),
        Ok(None) => error(StatusCode::NOT_FOUND, "app_map_not_found"),
        Err(r) => r,
    }
}
pub async fn map(
    ScopedState(state): ScopedState,
    Path(scope_id): Path<Uuid>,
    Query(mut filters): Query<MapQuery>,
) -> Response {
    if filters.scope_id.is_some() || filters.origin.is_some() {
        return error(StatusCode::BAD_REQUEST, "invalid_app_map_request");
    }
    filters.scope_id = Some(scope_id);
    read_map(&state, filters).await
}

/// How a run's map compares with every earlier run of the same app scope:
/// states and transitions seen for the first time, states the previous run
/// reached but this one did not, controls that now lead somewhere else, and
/// verdicts that changed on the same transition.
pub(crate) async fn compare_run(state: &AppState, run_id: Uuid) -> Response {
    let sql = "WITH run AS (SELECT r.run_id,r.created_at,r.workspace_id,r.user_id,
        COALESCE((SELECT array_agg(DISTINCT (s->>'scope_id')::uuid) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.config->'app_memory'->'scopes')='array' THEN r.config->'app_memory'->'scopes' ELSE '[]'::jsonb END) s WHERE s->>'scope_id' IS NOT NULL),'{}'::uuid[]) AS scopes
        FROM runtime_runs r WHERE r.run_id=$1 AND r.workspace_id=$2 AND r.user_id=$3),
      earlier AS (SELECT r.run_id,r.created_at FROM runtime_runs r,run WHERE r.workspace_id=run.workspace_id AND r.user_id=run.user_id AND r.run_id<>run.run_id
        AND r.created_at<run.created_at AND jsonb_typeof(r.config->'app_memory'->'scopes')='array'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.config->'app_memory'->'scopes') s WHERE s->>'scope_id' IS NOT NULL AND (s->>'scope_id')::uuid=ANY(run.scopes))),
      previous AS (SELECT run_id FROM earlier ORDER BY created_at DESC LIMIT 1),
      states AS (SELECT s.run_id,s.map_state_key k,s.page_template,s.url FROM exploration_states s WHERE s.map_state_key IS NOT NULL AND s.inherited_from_run_id IS NULL AND (s.run_id=$1 OR s.run_id IN (SELECT run_id FROM earlier))),
      edges AS (SELECT e.run_id,rr.created_at,a.ordinal,fs.map_state_key f,e.control_key c,ts.map_state_key t,fs.page_template fp,ts.page_template tp,
          a.assessment->>'verdict' v,a.action_id,a.spec->'command' cmd
        FROM exploration_edges e JOIN runtime_runs rr ON rr.run_id=e.run_id JOIN runtime_actions a ON a.action_id=e.action_id
        JOIN exploration_states fs ON fs.run_id=e.run_id AND fs.state_id=e.from_state_id JOIN exploration_states ts ON ts.run_id=e.run_id AND ts.state_id=e.to_state_id
        WHERE e.control_key IS NOT NULL AND fs.map_state_key IS NOT NULL AND ts.map_state_key IS NOT NULL AND (e.run_id=$1 OR e.run_id IN (SELECT run_id FROM earlier))),
      mine AS (SELECT * FROM edges WHERE run_id=$1),
      latest AS (SELECT DISTINCT ON (f,c) f,c,t,tp,v,action_id FROM edges WHERE run_id<>$1 ORDER BY f,c,created_at DESC,ordinal DESC),
      latest_same AS (SELECT DISTINCT ON (f,c,t) f,c,t,v,action_id FROM edges WHERE run_id<>$1 AND v IS NOT NULL ORDER BY f,c,t,created_at DESC,ordinal DESC),
      new_states AS (SELECT DISTINCT ON (k) k,page_template,url FROM states WHERE run_id=$1 AND k NOT IN (SELECT k FROM states WHERE run_id<>$1) ORDER BY k),
      missing AS (SELECT DISTINCT ON (k) k,page_template,url FROM states WHERE run_id IN (SELECT run_id FROM previous) AND k NOT IN (SELECT k FROM states WHERE run_id=$1) ORDER BY k),
      new_edges AS (SELECT DISTINCT ON (f,c,t) * FROM mine m WHERE NOT EXISTS(SELECT 1 FROM edges o WHERE o.run_id<>$1 AND o.f=m.f AND o.c=m.c AND o.t=m.t) ORDER BY f,c,t,ordinal),
      changed AS (SELECT DISTINCT ON (m.f,m.c) m.*,l.tp AS before_tp,l.action_id AS before_action_id FROM mine m JOIN latest l ON l.f=m.f AND l.c=m.c WHERE l.t<>m.t ORDER BY m.f,m.c,m.ordinal),
      verdicts AS (SELECT DISTINCT ON (m.f,m.c,m.t) m.*,l.v AS before_v,l.action_id AS before_action_id FROM mine m JOIN latest_same l ON l.f=m.f AND l.c=m.c AND l.t=m.t
        WHERE m.v IS NOT NULL AND m.v<>l.v AND m.v<>'inconclusive' AND l.v<>'inconclusive' ORDER BY m.f,m.c,m.t,m.ordinal DESC),
      label AS (SELECT action_id,CASE WHEN cmd->>'type'='navigate' THEN jsonb_build_object('action','navigate','url',cmd->>'url')
        ELSE jsonb_build_object('action',cmd->>'type','role',cmd->'control'->>'role','name',left(cmd->'control'->>'name',200)) END AS what FROM mine)
      SELECT jsonb_build_object('run_id',run.run_id,'scope_ids',run.scopes,'compared_runs',(SELECT count(*) FROM earlier),'previous_run_id',(SELECT run_id FROM previous),
        'counts',jsonb_build_object('states',(SELECT count(DISTINCT k) FROM states WHERE run_id=$1),'transitions',(SELECT count(DISTINCT (f,c,t)) FROM mine),
          'new_states',(SELECT count(*) FROM new_states),'not_reached_since_previous',(SELECT count(*) FROM missing),'new_transitions',(SELECT count(*) FROM new_edges),
          'changed_destinations',(SELECT count(*) FROM changed),'verdict_changes',(SELECT count(*) FROM verdicts),
          'regressions',(SELECT count(*) FROM verdicts WHERE before_v='no_issue_observed' AND v='suspect')),
        'new_states',(SELECT COALESCE(jsonb_agg(jsonb_build_object('state_key',k,'page_template',page_template,'url',url)),'[]'::jsonb) FROM (SELECT * FROM new_states LIMIT 50) x),
        'not_reached_since_previous',(SELECT COALESCE(jsonb_agg(jsonb_build_object('state_key',k,'page_template',page_template,'url',url)),'[]'::jsonb) FROM (SELECT * FROM missing LIMIT 50) x),
        'new_transitions',(SELECT COALESCE(jsonb_agg(jsonb_build_object('from_page_template',x.fp,'to_page_template',x.tp,'action_id',x.action_id,'verdict',x.v)||(SELECT what FROM label WHERE action_id=x.action_id)),'[]'::jsonb) FROM (SELECT * FROM new_edges LIMIT 50) x),
        'changed_destinations',(SELECT COALESCE(jsonb_agg(jsonb_build_object('from_page_template',x.fp,'before_to_page_template',x.before_tp,'now_to_page_template',x.tp,
            'action_id',x.action_id,'before_action_id',x.before_action_id)||(SELECT what FROM label WHERE action_id=x.action_id)),'[]'::jsonb) FROM (SELECT * FROM changed LIMIT 50) x),
        'verdict_changes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('from_page_template',x.fp,'to_page_template',x.tp,'before',x.before_v,'now',x.v,
            'change',CASE WHEN x.before_v='no_issue_observed' AND x.v='suspect' THEN 'regression' WHEN x.before_v='suspect' AND x.v='no_issue_observed' THEN 'no_longer_suspect' ELSE 'changed' END,
            'action_id',x.action_id,'before_action_id',x.before_action_id)||(SELECT what FROM label WHERE action_id=x.action_id)),'[]'::jsonb) FROM (SELECT * FROM verdicts LIMIT 50) x),
        'scope','Compares this run with earlier runs of the same app, screen size, sign-in state and model mode. A state not reached again was not visited; it is not proof that it was removed.',
        'untrusted_app_content',true) FROM run";
    match query(
        state,
        sql,
        &[
            &run_id,
            &state.principal.workspace_id,
            &state.principal.user_id,
        ],
    )
    .await
    {
        Ok(Some(mut v)) => {
            if v["scope_ids"].as_array().is_some_and(Vec::is_empty) {
                v["note"] = json!(
                    "This run did not use app memory, so it has no app scope to compare with."
                );
            }
            if v.to_string().len() > MAX_RESPONSE {
                return error(StatusCode::PAYLOAD_TOO_LARGE, "map_comparison_too_large");
            }
            Json::<Value>(v).into_response()
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "run_not_found"),
        Err(r) => r,
    }
}
pub async fn compare(ScopedState(state): ScopedState, Path(run_id): Path<Uuid>) -> Response {
    if run_id.is_nil() {
        return error(StatusCode::BAD_REQUEST, "invalid_run_id");
    }
    compare_run(&state, run_id).await
}
