//! Permanent issue identities, triage, known behavior, candidate-specific fix
//! verification and deployment rechecks.
use crate::{AppState, agent, error, identity::ScopedState, jobs, query};
use axum::{
    Json,
    body::to_bytes,
    extract::{Path, Query, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const TRIAGE_DECISIONS: [&str; 4] = ["bug", "intended_behavior", "duplicate", "needs_review"];
/// Untriaged, needs-review and bug issues are open; the rest are known.
const TRIAGE_FILTERS: [&str; 6] = [
    "open",
    "untriaged",
    "needs_review",
    "bug",
    "intended_behavior",
    "duplicate",
];
pub const MAX_RECHECK_ISSUES: i64 = 25;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    pub query: Option<String>,
    pub outcome: Option<String>,
    pub triage: Option<String>,
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
            && self
                .triage
                .as_deref()
                .is_none_or(|s| TRIAGE_FILTERS.contains(&s))
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
    let sql = "WITH candidates AS (SELECT scout_issue_summary(i) item FROM issues i WHERE workspace_id=$1 AND user_id=$2 AND ($3::text IS NULL OR position(lower($3) in lower(COALESCE(i.snapshot->>'title','')||' '||i.source_target_url))>0)),filtered AS (SELECT item FROM candidates WHERE ($4::text IS NULL OR COALESCE(item->'latest_verification'->>'outcome',CASE WHEN item->'latest_verification'->>'status' IN ('queued','running') THEN 'running' ELSE 'unverified' END)=$4) AND ($7::text IS NULL OR item->>'triage_status'=$7 OR ($7='open' AND item->>'triage_status' IN ('untriaged','needs_review','bug')))) SELECT jsonb_build_object('issues',COALESCE((SELECT jsonb_agg(item ORDER BY item->>'last_seen_at' DESC,item->>'issue_id') FROM (SELECT item FROM filtered ORDER BY item->>'last_seen_at' DESC,item->>'issue_id' OFFSET $5 LIMIT $6) page),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),'offset',$5::bigint,'limit',$6::bigint,'next_offset',CASE WHEN (SELECT count(*) FROM filtered)>$5+$6 THEN $5+$6 ELSE NULL END,'untrusted_app_content',true,'verification_scope','individual_candidate_not_global_resolution')";
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
            &filters.triage,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageInput {
    pub decision: String,
    pub rationale: String,
    pub duplicate_of: Option<Uuid>,
    pub expected_revision: Option<i32>,
}
impl TriageInput {
    fn validate(&self) -> Result<(), &'static str> {
        if !TRIAGE_DECISIONS.contains(&self.decision.as_str()) {
            return Err("invalid_triage_decision");
        }
        let rationale = self.rationale.trim();
        if rationale.is_empty()
            || rationale.chars().count() > 2000
            || rationale.chars().any(|c| c.is_control() && c != '\n')
        {
            return Err("invalid_triage_rationale");
        }
        if (self.decision == "duplicate") != self.duplicate_of.is_some()
            || self.duplicate_of.is_some_and(|id| id.is_nil())
        {
            return Err("duplicate_of_required_for_duplicates_only");
        }
        if self.expected_revision.is_some_and(|v| v < 0) {
            return Err("invalid_expected_revision");
        }
        Ok(())
    }
}
/// Records a decision as the person or agent behind this request. Agent tools
/// and agent credentials decide as agents; they never replace a person's decision.
pub(crate) async fn record_triage(
    state: &AppState,
    id: Uuid,
    input: TriageInput,
    agent_tool: bool,
) -> Response {
    if id.is_nil() {
        return error(StatusCode::BAD_REQUEST, "invalid_issue_id");
    }
    if let Err(code) = input.validate() {
        return error(StatusCode::BAD_REQUEST, code);
    }
    let actor = if agent_tool || state.principal.agent_id.is_some() {
        "agent"
    } else {
        "human"
    };
    let Some(queue) = &state.jobs else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "triage_unavailable");
    };
    let value = match queue
        .write_json(
            "SELECT scout_triage_issue($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            &[
                &id,
                &state.principal.workspace_id,
                &state.principal.user_id,
                &actor,
                &state.principal.agent_id,
                &input.decision,
                &input.duplicate_of,
                &input.rationale,
                &input.expected_revision,
            ],
        )
        .await
    {
        Ok(Some(value)) => value,
        Ok(None) => return error(StatusCode::SERVICE_UNAVAILABLE, "triage_unavailable"),
        Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
    };
    let status = match value["error"].as_str() {
        None if value["reused"] == true => StatusCode::OK,
        None => StatusCode::CREATED,
        Some("issue_not_found" | "duplicate_target_not_found") => StatusCode::NOT_FOUND,
        Some("triage_revision_conflict" | "human_decision_present") => StatusCode::CONFLICT,
        Some(_) => StatusCode::BAD_REQUEST,
    };
    let mut body = value;
    body["issue_id"] = json!(id);
    body["effect"] = json!(match input.decision.as_str() {
        "intended_behavior" =>
            "Later suspects with the same page and control are recorded as known intended behavior.",
        "duplicate" =>
            "This issue and later suspects with the same page and control roll up to the canonical issue.",
        "bug" =>
            "Kept open: included in deployment rechecks; later suspects with the same page and control are recorded as duplicates of it.",
        _ => "Kept open for a decision.",
    });
    (status, Json(body)).into_response()
}
pub async fn triage(
    ScopedState(state): ScopedState,
    Path(id): Path<Uuid>,
    input: Result<Json<TriageInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return error(StatusCode::BAD_REQUEST, "invalid_triage_request");
    };
    record_triage(&state, id, input, false).await
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeFilters {
    pub origin: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}
/// Known behavior: issues triaged as bugs or intended behavior, with the
/// duplicates and Scout's later matches rolled up into each one.
pub async fn knowledge(
    ScopedState(state): ScopedState,
    Query(filters): Query<KnowledgeFilters>,
) -> Response {
    let origin = match filters.origin.as_deref().map(origin_of).transpose() {
        Ok(origin) => origin,
        Err(code) => return error(StatusCode::BAD_REQUEST, code),
    };
    let (offset, limit) = (filters.offset.unwrap_or(0), filters.limit.unwrap_or(20));
    if !(0..=100000).contains(&offset) || !(1..=50).contains(&limit) {
        return error(StatusCode::BAD_REQUEST, "invalid_knowledge_filters");
    }
    let sql = "WITH known AS (SELECT i.*,t.decision,t.rationale,t.actor,t.agent_id,t.created_at AS decided_at,b.page_url,b.command,b.signed_in
        FROM issues i JOIN LATERAL (SELECT * FROM issue_triage WHERE issue_id=i.issue_id ORDER BY revision DESC LIMIT 1) t ON t.decision IN ('bug','intended_behavior') AND t.matched_issue_id IS NULL
        LEFT JOIN issue_behaviors b ON b.issue_id=i.issue_id
        WHERE i.workspace_id=$1 AND i.user_id=$2 AND ($3::text IS NULL OR i.source_target_url=$3 OR starts_with(i.source_target_url,$3||'/') OR starts_with(i.source_target_url,$3||'?'))),
      related AS (SELECT d.issue_id,CASE WHEN dt.decision='duplicate' THEN scout_canonical_issue(d.issue_id) ELSE dt.matched_issue_id END AS known_id FROM issues d
        JOIN LATERAL (SELECT * FROM issue_triage WHERE issue_id=d.issue_id ORDER BY revision DESC LIMIT 1) dt ON dt.decision='duplicate' OR dt.matched_issue_id IS NOT NULL
        WHERE d.workspace_id=$1 AND d.user_id=$2),
      items AS (SELECT jsonb_build_object('issue_id',k.issue_id,'decision',k.decision,'rationale',k.rationale,'decided_by',k.actor,'agent_id',k.agent_id,'decided_at',k.decided_at,
        'title',k.snapshot->>'title','expected_result',left(k.snapshot->>'expected_result',300),'observed_result',left(k.snapshot->>'observed_result',300),
        'page_url',k.page_url,'control',jsonb_build_object('role',k.command->'control'->>'role','name',k.command->'control'->>'name','href',k.command->'control'->>'href'),
        'action',k.command->>'type','viewport_profile',k.snapshot->>'viewport_profile','signed_in',k.signed_in,'source_target_url',k.source_target_url,
        'duplicates',(SELECT count(*) FROM related r WHERE r.known_id=k.issue_id),
        'occurrences',(SELECT count(*) FROM issue_occurrences o WHERE o.issue_id=k.issue_id OR o.issue_id IN (SELECT r.issue_id FROM related r WHERE r.known_id=k.issue_id)),
        'last_seen_at',k.last_seen_at,'latest_verification',(SELECT v.outcome FROM issue_verifications v WHERE v.issue_id=k.issue_id ORDER BY v.created_at DESC,v.verification_id DESC LIMIT 1)) AS item,
        k.decided_at,k.issue_id FROM known k)
      SELECT jsonb_build_object('known_behaviors',COALESCE((SELECT jsonb_agg(item ORDER BY decided_at DESC,issue_id) FROM (SELECT * FROM items ORDER BY decided_at DESC,issue_id OFFSET $4 LIMIT $5) page),'[]'::jsonb),
        'total',(SELECT count(*) FROM items),'offset',$4::bigint,'limit',$5::bigint,'next_offset',CASE WHEN (SELECT count(*) FROM items)>$4+$5 THEN $4+$5 END,
        'matching','Later suspects with the same page, control, viewport and sign-in state are triaged like the known issue. Evidence is always recorded.',
        'untrusted_app_content',true)";
    match query(
        &state,
        sql,
        &[
            &state.principal.workspace_id,
            &state.principal.user_id,
            &origin,
            &offset,
            &limit,
        ],
    )
    .await
    {
        Ok(Some(v)) if v.to_string().len() <= 128 * 1024 => Json(v).into_response(),
        Ok(Some(_)) => error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "knowledge_page_too_large_reduce_limit",
        ),
        Ok(None) => error(StatusCode::SERVICE_UNAVAILABLE, "knowledge_unavailable"),
        Err(r) => r,
    }
}

fn origin_of(value: &str) -> Result<String, &'static str> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid_origin")?;
    if value.len() > 2048
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("invalid_origin");
    }
    Ok(url.origin().ascii_serialization())
}
/// The same recheck and issue always name the same verification, so a retried
/// recheck reuses every job it already admitted.
fn recheck_item_id(recheck: Uuid, issue: Uuid) -> Uuid {
    let digest = Sha256::digest([recheck.as_bytes().as_slice(), issue.as_bytes()].concat());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}
/// The candidate keeps each issue's entry path and query on the new origin.
fn candidate_for(source_target_url: &str, candidate_origin: &str) -> Option<String> {
    let source = reqwest::Url::parse(source_target_url).ok()?;
    let mut candidate = reqwest::Url::parse(candidate_origin).ok()?;
    candidate.set_path(source.path());
    candidate.set_query(source.query());
    Some(candidate.to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecheckInput {
    pub recheck_id: Uuid,
    pub candidate_url: String,
    pub source_origin: Option<String>,
    pub deployment_ref: Option<String>,
    pub project_id: Option<Uuid>,
    pub task_id: Option<Uuid>,
}
pub(crate) async fn start_recheck(state: &AppState, input: RecheckInput) -> Response {
    let Some(queue) = &state.jobs else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "browser_queue_unavailable");
    };
    if input.recheck_id.is_nil()
        || input.project_id.is_some_and(|id| id.is_nil())
        || input.task_id.is_some_and(|id| id.is_nil())
    {
        return error(StatusCode::BAD_REQUEST, "invalid_recheck_id");
    }
    let candidate_origin = match origin_of(&input.candidate_url) {
        Ok(origin) => origin,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_candidate_url"),
    };
    let source_origin = match input.source_origin.as_deref().map(origin_of).transpose() {
        Ok(origin) => origin.unwrap_or_else(|| candidate_origin.clone()),
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_source_origin"),
    };
    let deployment = input.deployment_ref.as_deref().map(str::trim);
    if deployment.is_some_and(|v| v.is_empty() || v.len() > 200 || v.chars().any(char::is_control))
    {
        return error(StatusCode::BAD_REQUEST, "invalid_deployment_ref");
    }
    // Refuse a candidate the queue would refuse, before recording the recheck.
    let allowed = match queue.effective_settings().await {
        Ok(v) => v["settings"]["allowedOrigins"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
    };
    if let Err(code) = jobs::target(&candidate_origin, &allowed) {
        return error(StatusCode::BAD_REQUEST, code);
    }
    let sql = "WITH open AS (SELECT i.issue_id,i.last_seen_at FROM issues i WHERE i.workspace_id=$1 AND i.user_id=$2
        AND (i.source_target_url=$3 OR starts_with(i.source_target_url,$3||'/') OR starts_with(i.source_target_url,$3||'?'))
        AND COALESCE((SELECT decision FROM issue_triage t WHERE t.issue_id=i.issue_id ORDER BY revision DESC LIMIT 1),'untriaged') IN ('untriaged','needs_review','bug')),
      picked AS (SELECT issue_id FROM open ORDER BY last_seen_at DESC,issue_id LIMIT $8),
      inserted AS (INSERT INTO issue_rechecks(recheck_id,workspace_id,user_id,agent_id,source_origin,candidate_origin,deployment_ref,issue_ids,omitted_issues)
        SELECT $4,$1,$2,$5,$3,$6,$7,COALESCE((SELECT array_agg(issue_id ORDER BY issue_id) FROM picked),'{}'),GREATEST((SELECT count(*) FROM open)-$8,0)
        ON CONFLICT (recheck_id) DO NOTHING RETURNING recheck_id)
      SELECT jsonb_build_object('created',EXISTS(SELECT 1 FROM inserted))";
    let created = match queue
        .write_json(
            sql,
            &[
                &state.principal.workspace_id,
                &state.principal.user_id,
                &source_origin,
                &input.recheck_id,
                &state.principal.agent_id,
                &candidate_origin,
                &deployment,
                &MAX_RECHECK_ISSUES,
            ],
        )
        .await
    {
        Ok(Some(v)) => v["created"] == true,
        Ok(None) => return error(StatusCode::SERVICE_UNAVAILABLE, "recheck_unavailable"),
        Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
    };
    let saved = match query(state, "SELECT jsonb_build_object('recheck',to_jsonb(r),'issues',COALESCE((SELECT jsonb_agg(jsonb_build_object('issue_id',i.issue_id,'source_target_url',i.source_target_url) ORDER BY i.issue_id) FROM issues i WHERE i.issue_id=ANY(r.issue_ids)),'[]'::jsonb),'done',COALESCE((SELECT jsonb_agg(issue_id) FROM issue_recheck_items WHERE recheck_id=r.recheck_id),'[]'::jsonb)) FROM issue_rechecks r WHERE recheck_id=$1", &[&input.recheck_id]).await {
        Ok(Some(v)) => v,
        Ok(None) => return error(StatusCode::SERVICE_UNAVAILABLE, "recheck_unavailable"),
        Err(r) => return r,
    };
    let recheck = &saved["recheck"];
    if recheck["workspace_id"] != json!(state.principal.workspace_id)
        || recheck["user_id"] != json!(state.principal.user_id)
        || recheck["source_origin"] != json!(source_origin)
        || recheck["candidate_origin"] != json!(candidate_origin)
        || recheck["deployment_ref"] != json!(deployment)
    {
        return error(StatusCode::CONFLICT, "recheck_id_conflict");
    }
    let providers = state
        .gateway
        .as_ref()
        .map(|g| g.providers())
        .unwrap_or(json!({}));
    let done = saved["done"].as_array().cloned().unwrap_or_default();
    for issue in saved["issues"].as_array().into_iter().flatten() {
        if done.contains(&issue["issue_id"]) {
            continue;
        }
        let issue_id =
            Uuid::parse_str(issue["issue_id"].as_str().unwrap_or_default()).unwrap_or_default();
        let verification_id = recheck_item_id(input.recheck_id, issue_id);
        let admitted = match candidate_for(
            issue["source_target_url"].as_str().unwrap_or_default(),
            &candidate_origin,
        ) {
            None => Err("invalid_target_url"),
            Some(target) => queue
                .admit(
                    jobs::Submission::recheck_item(
                        verification_id,
                        issue_id,
                        target,
                        deployment.map(str::to_owned),
                        input.project_id,
                        input.task_id,
                        MAX_RECHECK_ISSUES + 10,
                    ),
                    providers.clone(),
                )
                .await
                .map(|_| ()),
        };
        // A transient refusal leaves the item unrecorded; the same recheck_id resumes it.
        if let Err(
            code @ ("database_unavailable" | "browser_queue_full" | "provider_not_configured"),
        ) = admitted
        {
            return error(StatusCode::SERVICE_UNAVAILABLE, code);
        }
        let (verification, skipped) = match admitted {
            Ok(()) => (Some(verification_id), None),
            Err(code) => (None, Some(code)),
        };
        if let Err(code) = queue.write_json("INSERT INTO issue_recheck_items(recheck_id,issue_id,verification_id,skipped_reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING to_jsonb(recheck_id)",
            &[&input.recheck_id, &issue_id, &verification, &skipped]).await {
            return error(StatusCode::SERVICE_UNAVAILABLE, code);
        }
    }
    match recheck_summary(state, input.recheck_id).await {
        Ok(mut v) => {
            v["reused"] = json!(!created);
            v["next"] = json!({"recheck":{"name":"scout_get_recheck","arguments":{"recheck_id":input.recheck_id}},"poll_after_ms":10000,"disconnect_cancels_work":false});
            (
                if created {
                    StatusCode::ACCEPTED
                } else {
                    StatusCode::OK
                },
                Json(v),
            )
                .into_response()
        }
        Err(r) => r,
    }
}
async fn recheck_summary(state: &AppState, id: Uuid) -> Result<Value, Response> {
    match query(state, "SELECT scout_recheck_summary(r.recheck_id) FROM issue_rechecks r WHERE r.recheck_id=$1 AND r.workspace_id=$2 AND r.user_id=$3",
        &[&id, &state.principal.workspace_id, &state.principal.user_id]).await {
        Ok(Some(mut v)) => {
            v["scope"] = json!("Each item checks one issue's recorded behavior on this deployment. A resolved item is not a global fix, and issues triaged as intended behavior or duplicates are not rechecked.");
            v["untrusted_app_content"] = json!(true);
            Ok(v)
        }
        Ok(None) => Err(error(StatusCode::NOT_FOUND, "recheck_not_found")),
        Err(r) => Err(r),
    }
}
pub async fn recheck(
    ScopedState(state): ScopedState,
    input: Result<Json<RecheckInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return error(StatusCode::BAD_REQUEST, "invalid_recheck_request");
    };
    start_recheck(&state, input).await
}
pub async fn recheck_status(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    if id.is_nil() {
        return error(StatusCode::BAD_REQUEST, "invalid_recheck_id");
    }
    match recheck_summary(&state, id).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(decision: &str, duplicate_of: Option<Uuid>) -> TriageInput {
        TriageInput {
            decision: decision.into(),
            rationale: "Checked against the product spec.".into(),
            duplicate_of,
            expected_revision: None,
        }
    }

    #[test]
    fn triage_input_requires_a_target_only_for_duplicates() {
        assert!(input("intended_behavior", None).validate().is_ok());
        assert!(input("duplicate", Some(Uuid::new_v4())).validate().is_ok());
        assert_eq!(
            input("duplicate", None).validate(),
            Err("duplicate_of_required_for_duplicates_only")
        );
        assert_eq!(
            input("bug", Some(Uuid::new_v4())).validate(),
            Err("duplicate_of_required_for_duplicates_only")
        );
        assert_eq!(
            input("duplicate", Some(Uuid::nil())).validate(),
            Err("duplicate_of_required_for_duplicates_only")
        );
        assert_eq!(
            input("wontfix", None).validate(),
            Err("invalid_triage_decision")
        );
        let mut blank = input("bug", None);
        blank.rationale = "   ".into();
        assert_eq!(blank.validate(), Err("invalid_triage_rationale"));
        blank.rationale = "a\u{7}b".into();
        assert_eq!(blank.validate(), Err("invalid_triage_rationale"));
        blank.rationale = "x".repeat(2001);
        assert_eq!(blank.validate(), Err("invalid_triage_rationale"));
    }

    #[test]
    fn recheck_candidates_keep_the_issue_path_on_the_new_origin() {
        assert_eq!(
            candidate_for(
                "https://staging.example/app/cart?step=2",
                "https://preview-42.example"
            )
            .as_deref(),
            Some("https://preview-42.example/app/cart?step=2")
        );
        assert_eq!(
            candidate_for(
                "http://exploration-fixture:8082/branches",
                "http://candidate-fixture:8082"
            )
            .as_deref(),
            Some("http://candidate-fixture:8082/branches")
        );
        assert_eq!(
            origin_of("https://Preview.Example:443/path?q=1").unwrap(),
            "https://preview.example"
        );
        assert!(origin_of("ftp://example.com/").is_err());
        assert!(origin_of("https://user:pass@example.com/").is_err());
    }

    #[test]
    fn recheck_items_have_stable_distinct_verification_ids() {
        let (recheck, a, b) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(recheck_item_id(recheck, a), recheck_item_id(recheck, a));
        assert_ne!(recheck_item_id(recheck, a), recheck_item_id(recheck, b));
        assert_ne!(
            recheck_item_id(recheck, a),
            recheck_item_id(Uuid::new_v4(), a)
        );
        assert_eq!(recheck_item_id(recheck, a).get_version_num(), 5);
    }
}
