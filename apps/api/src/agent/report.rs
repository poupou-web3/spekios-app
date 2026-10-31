//! Recorded observations projected into an asynchronous coding-agent handoff.
//! These reads perform no inference, browser action, source-code inspection or
//! human review. Missing facts remain missing; a visual change is not a bug.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    job_id: Option<Uuid>,
    run_id: Option<Uuid>,
}
impl Selection {
    fn validate(&self) -> Result<(), ErrorData> {
        if self.job_id.is_some() == self.run_id.is_some() {
            return Err(invalid("Supply exactly one job_id or run_id."));
        }
        checked(self.job_id.or(self.run_id).unwrap())?;
        Ok(())
    }
    fn arguments(&self) -> Value {
        match self.job_id {
            Some(id) => json!({"job_id":id}),
            None => json!({"run_id":self.run_id}),
        }
    }
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportQuery {
    offset: Option<usize>,
    limit: Option<usize>,
    include_changes: Option<bool>,
    expected_snapshot: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportArgs {
    job_id: Option<Uuid>,
    run_id: Option<Uuid>,
    offset: Option<usize>,
    limit: Option<usize>,
    include_changes: Option<bool>,
    expected_snapshot: Option<String>,
}
impl ReportQuery {
    fn validate(&self) -> Result<(), ErrorData> {
        if self.offset.unwrap_or(0) > 100_000 || !(1..=10).contains(&self.limit.unwrap_or(4)) {
            return Err(invalid("Report offset must be 0..100000 and limit 1..10."));
        }
        if self
            .expected_snapshot
            .as_ref()
            .is_some_and(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()))
        {
            return Err(invalid("expected_snapshot must be a 64-character SHA256."));
        }
        Ok(())
    }
}
fn tool_call(name: &str, arguments: Value) -> Value {
    json!({"name":name,"arguments":arguments})
}
pub(super) fn workflow(selection: Value) -> Value {
    json!({"durable":true,"disconnect_cancels_work":false,
        "progress":tool_call("scout_get_progress",selection.clone()),
        "report":tool_call("scout_get_report",selection),
        "poll_after_ms":5000})
}
fn terminal(status: &Value) -> bool {
    matches!(
        status.as_str(),
        Some("completed" | "failed" | "blocked" | "cancelled" | "interrupted")
    )
}
fn has_text(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty())
}
fn text(value: &Value, limit: usize) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    let s = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    json!(
        s.chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
            .take(limit)
            .collect::<String>()
    )
}
fn first(values: &[&Value], max: usize) -> Value {
    values
        .iter()
        .find(|v| !v.is_null())
        .map(|v| text(v, max))
        .unwrap_or(Value::Null)
}

async fn read_progress(state: &AppState, selection: &Selection) -> Result<Value, CallToolResult> {
    // Unlike the raw report this does not aggregate screenshots, model payloads,
    // diagnostic events or the graph. Queued/pre-launch failed jobs remain visible.
    let sql = r#"
      WITH picked AS (
        SELECT to_jsonb(j) AS job,j.run_id FROM browser_jobs j
          WHERE $1::uuid IS NOT NULL AND j.job_id=$1 AND j.workspace_id=$3 AND j.user_id=$4
        UNION ALL
        SELECT NULL::jsonb,r.run_id FROM runtime_runs r
          WHERE $1::uuid IS NULL AND r.run_id=$2::uuid AND r.workspace_id=$3 AND r.user_id=$4
      )
      SELECT jsonb_build_object('job',p.job,'run',to_jsonb(r),'steering',CASE WHEN r.run_id IS NULL THEN NULL ELSE scout_steering_snapshot(r.run_id) END,
        'actions',(SELECT jsonb_build_object('recorded',count(*),
          'completed',count(*) FILTER(WHERE a.state='completed'),
          'in_flight',count(*) FILTER(WHERE a.state IN ('prepared','dispatched')),
          'failed',count(*) FILTER(WHERE a.state IN ('interrupted','evidence_failed') OR a.tool_error IS NOT NULL),
          'assessed',count(*) FILTER(WHERE a.assessment IS NOT NULL),
          'suspect',count(*) FILTER(WHERE a.assessment->>'verdict'='suspect'),
          'inconclusive',count(*) FILTER(WHERE a.assessment->>'verdict'='inconclusive'))
          FROM runtime_actions a WHERE a.run_id=r.run_id),
        'captures',(SELECT jsonb_build_object('available',count(*) FILTER(WHERE status='available'),
          'pending',count(*) FILTER(WHERE status IN ('capturing','pending_upload')),
          'failed',count(*) FILTER(WHERE status='failed')) FROM runtime_captures WHERE run_id=r.run_id),
        'pending_model_requests',(SELECT count(*) FROM model_requests WHERE run_id=r.run_id AND state IN ('queued','preparing','dispatched')),
        'latest_event',(SELECT jsonb_build_object('seq',seq,'type',event_type,'action_id',action_id,'occurred_at',occurred_at)
          FROM runtime_events WHERE run_id=r.run_id ORDER BY seq DESC LIMIT 1),
        'access_requests',COALESCE((SELECT jsonb_agg(jsonb_build_object('access_id',a.access_id,'run_id',a.run_id,'status',a.status,
          'reason',a.reason,'origin',a.origin,'created_at',a.created_at,'expires_at',a.expires_at) ORDER BY a.created_at)
          FROM browser_access_requests a WHERE a.run_id=r.run_id AND a.workspace_id=$3 AND a.user_id=$4
          AND a.status IN ('waiting','active')),'[]'::jsonb),
        'worker',(SELECT jsonb_build_object('status',w.status,'heartbeat_at',w.heartbeat_at,
          'available',w.status='online' AND w.heartbeat_at>now()-interval '20 seconds')
          FROM browser_workers w WHERE w.worker_id=(p.job->>'worker_id')::uuid AND w.workspace_id=$3))
      FROM picked p LEFT JOIN runtime_runs r ON r.run_id=p.run_id AND r.workspace_id=$3 AND r.user_id=$4
    "#;
    match query(
        state,
        sql,
        &[
            &selection.job_id,
            &selection.run_id,
            &state.principal.workspace_id,
            &state.principal.user_id,
        ],
    )
    .await
    {
        Ok(Some(raw)) => Ok(progress_view(&raw, selection)),
        Ok(None) => Err(failure(
            if selection.job_id.is_some() {
                "job_not_found"
            } else {
                "run_not_found"
            },
            404,
        )),
        Err(response) => Err(decode(response).await.unwrap_err()),
    }
}
fn progress_view(raw: &Value, selection: &Selection) -> Value {
    let job = &raw["job"];
    let run = &raw["run"];
    let finished = if job.is_null() {
        terminal(&run["lifecycle"])
    } else {
        terminal(&job["status"])
    };
    let phase = if finished {
        if !job.is_null() {
            job["status"].clone()
        } else {
            run["lifecycle"].clone()
        }
    } else if !list(&raw["access_requests"]).is_empty() {
        json!("awaiting_user")
    } else if !job["cancel_id"].is_null() || !run["cancel_id"].is_null() {
        json!("stopping")
    } else if run.is_null() {
        job["status"]
            .as_str()
            .map(|s| json!(if s == "queued" { "queued" } else { "starting" }))
            .unwrap_or(json!("starting"))
    } else if raw["pending_model_requests"].as_i64().unwrap_or(0) > 0 {
        json!("awaiting_model")
    } else {
        json!("exploring")
    };
    let run_id = run["run_id"].clone();
    json!({"schema_version":1,"job":if job.is_null(){Value::Null}else{fields(job,&["job_id","status","run_id","created_at","started_at","finished_at","error","execution_mode","cancel_requested_at"])},
      "run":if run.is_null(){Value::Null}else{fields(run,&["run_id","target_url","lifecycle","created_at","finished_at","error","cancel_requested_at"])},
      "target_url":if run.is_null(){job["request"]["target_url"].clone()}else{run["target_url"].clone()},
      "phase":phase,"execution_finished":finished,"report_available":!run_id.is_null()||finished,
      "needs_user_input":!list(&raw["access_requests"]).is_empty(),"access_requests":raw["access_requests"],
      "counts":{"actions":raw["actions"],"captures":raw["captures"],"pending_model_requests":raw["pending_model_requests"]},
      "steering":raw["steering"],"latest_event":raw["latest_event"],"event_cursor":raw["latest_event"]["seq"].as_i64().unwrap_or(0),
      "worker":raw["worker"],"observed_at":chrono::Utc::now().to_rfc3339(),"poll_after_ms":if finished{Value::Null}else{json!(5000)},
      "next":workflow(selection.arguments()),"coverage_complete":false,
      "progress_percent":null,"untrusted_app_content":true})
}
pub(super) async fn progress_tool(
    state: &AppState,
    input: Value,
) -> Result<CallToolResult, ErrorData> {
    let selection: Selection = args(input)?;
    selection.validate()?;
    Ok(match read_progress(state, &selection).await {
        Ok(v) => result(v),
        Err(e) => e,
    })
}
pub(super) async fn report_tool(
    state: &AppState,
    input: Value,
) -> Result<CallToolResult, ErrorData> {
    let a: ReportArgs = args(input)?;
    let selection = Selection {
        job_id: a.job_id,
        run_id: a.run_id,
    };
    selection.validate()?;
    let query = ReportQuery {
        offset: a.offset,
        limit: a.limit,
        include_changes: a.include_changes,
        expected_snapshot: a.expected_snapshot,
    };
    query.validate()?;
    Ok(match read_report(state, &selection, &query).await {
        Ok(v) => result(v),
        Err(e) => e,
    })
}
pub(super) async fn issue_tool(
    state: &AppState,
    input: Value,
) -> Result<CallToolResult, ErrorData> {
    let a: ActionArgs = args(input)?;
    checked(a.run_id)?;
    checked(a.action_id)?;
    Ok(match run_report(state, a.run_id).await {
        Ok(report) => match list(&report["actions"])
            .iter()
            .find(|v| v["action_id"] == a.action_id.to_string())
        {
            Some(action) => result(issue_packet(&report, action)),
            None => failure("action_not_in_run", 404),
        },
        Err(e) => e,
    })
}
async fn read_report(
    state: &AppState,
    selection: &Selection,
    options: &ReportQuery,
) -> Result<Value, CallToolResult> {
    let progress = read_progress(state, selection).await?;
    let Some(id) = progress["run"]["run_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return Ok(
            json!({"schema_version":1,"report_state":if progress["execution_finished"]==true{"execution_ended_without_run"}else{"not_started"},
          "execution_finished":progress["execution_finished"],"progress":progress,"issues":[],"total_items":0,
          "has_more":false,"next_offset":null,"coverage_complete":false,
          "limitations":["No recorded browser run is available. This is not a passing QA result."],
          "codebase_inspected":false,"untrusted_app_content":true}),
        );
    };
    let report = run_report(state, id).await?;
    if options
        .expected_snapshot
        .as_ref()
        .is_some_and(|s| *s != snapshot_id(&report))
    {
        return Err(failure(
            "report_snapshot_changed_restart_from_offset_zero",
            409,
        ));
    }
    Ok(build_report(&report, Some(progress), options))
}

fn response(value: Result<Value, CallToolResult>) -> Response {
    match value {
        Ok(v) => {
            if v.to_string().len() <= MAX_JSON {
                Json(v).into_response()
            } else {
                crate::error(StatusCode::PAYLOAD_TOO_LARGE, "agent_result_too_large")
            }
        }
        Err(e) => {
            let data = e
                .structured_content
                .unwrap_or(json!({"error":"report_unavailable","http_status":503}));
            let status = data["http_status"]
                .as_u64()
                .and_then(|s| StatusCode::from_u16(s as u16).ok())
                .unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
            (status, Json(data)).into_response()
        }
    }
}
pub async fn job_progress(ScopedState(state): ScopedState, Path(job_id): Path<Uuid>) -> Response {
    if job_id.is_nil() {
        return crate::error(StatusCode::BAD_REQUEST, "invalid_job_id");
    }
    response(
        read_progress(
            &state,
            &Selection {
                job_id: Some(job_id),
                run_id: None,
            },
        )
        .await,
    )
}
pub async fn run_progress(ScopedState(state): ScopedState, Path(run_id): Path<Uuid>) -> Response {
    if run_id.is_nil() {
        return crate::error(StatusCode::BAD_REQUEST, "invalid_run_id");
    }
    response(
        read_progress(
            &state,
            &Selection {
                job_id: None,
                run_id: Some(run_id),
            },
        )
        .await,
    )
}
pub async fn job_report(
    ScopedState(state): ScopedState,
    Path(job_id): Path<Uuid>,
    Query(options): Query<ReportQuery>,
) -> Response {
    if job_id.is_nil() || options.validate().is_err() {
        return crate::error(StatusCode::BAD_REQUEST, "invalid_report_arguments");
    }
    response(
        read_report(
            &state,
            &Selection {
                job_id: Some(job_id),
                run_id: None,
            },
            &options,
        )
        .await,
    )
}
pub async fn run_report_http(
    ScopedState(state): ScopedState,
    Path(run_id): Path<Uuid>,
    Query(options): Query<ReportQuery>,
) -> Response {
    if run_id.is_nil() || options.validate().is_err() {
        return crate::error(StatusCode::BAD_REQUEST, "invalid_report_arguments");
    }
    response(
        read_report(
            &state,
            &Selection {
                job_id: None,
                run_id: Some(run_id),
            },
            &options,
        )
        .await,
    )
}
pub async fn issue_http(
    ScopedState(state): ScopedState,
    Path((run_id, action_id)): Path<(Uuid, Uuid)>,
) -> Response {
    if run_id.is_nil() || action_id.is_nil() {
        return crate::error(StatusCode::BAD_REQUEST, "invalid_issue_id");
    }
    response(match run_report(&state, run_id).await {
        Ok(report) => match list(&report["actions"])
            .iter()
            .find(|v| v["action_id"] == action_id.to_string())
        {
            Some(action) => Ok(issue_packet(&report, action)),
            None => Err(failure("action_not_in_run", 404)),
        },
        Err(e) => Err(e),
    })
}

fn owned_actions(report: &Value) -> Vec<&Value> {
    let mut actions: Vec<_> = list(&report["actions"])
        .iter()
        .filter(|a| a["run_id"] == report["run"]["run_id"])
        .collect();
    actions.sort_by_key(|a| a["ordinal"].as_i64().unwrap_or(i64::MAX));
    actions
}
fn expected(action: &Value) -> Value {
    first(
        &[
            &action["spec"]["prediction"]["expected_result"],
            &action["spec"]["prediction"]["expected"],
            &action["assessment"]["expected"],
        ],
        2000,
    )
}
fn category(action: &Value) -> Option<&'static str> {
    if has_text(&action["tool_error"])
        || matches!(
            action["state"].as_str(),
            Some("evidence_failed" | "interrupted")
        )
    {
        return Some("execution_problem");
    }
    if action["assessment"].is_null() {
        return Some(
            if matches!(action["state"].as_str(), Some("prepared" | "dispatched")) {
                "pending_check"
            } else {
                "inconclusive"
            },
        );
    }
    if action["assessment"]["verdict"] == "suspect" {
        return Some(
            if action["assessment"]["expectation_uncertain"] == true || expected(action).is_null() {
                "inconclusive"
            } else {
                "suspected_bug"
            },
        );
    }
    if action["assessment"]["verdict"] == "inconclusive" {
        return Some("inconclusive");
    }
    if ["http_errors", "request_failures", "console_errors"]
        .iter()
        .any(|k| action["outcome"]["diagnostics"][k].as_i64().unwrap_or(0) > 0)
        || action["outcome"]["status"]
            .as_str()
            .is_some_and(|s| s != "settled")
    {
        return Some("diagnostic_signal");
    }
    if action["comparison"]["counts"]["changed_pixels"]
        .as_u64()
        .unwrap_or(0)
        > 0
        || action["comparison"]["geometry_changed"] == true
    {
        return Some("observed_change");
    }
    None
}
fn priority(action: &Value) -> u8 {
    match category(action) {
        Some("suspected_bug") => 0,
        Some("execution_problem") => 1,
        Some("inconclusive") => 2,
        Some("diagnostic_signal") => 3,
        Some("pending_check") => 4,
        _ => 5,
    }
}
fn capture<'a>(report: &'a Value, action: &Value, phase: &str) -> Option<&'a Value> {
    let id = &action[format!("{phase}_capture_id")];
    list(&report["captures"]).iter().find(|c| {
        !id.is_null()
            && c["capture_id"] == *id
            && c["run_id"] == report["run"]["run_id"]
            && c["action_id"] == action["action_id"]
            && c["phase"] == phase
    })
}
fn capture_ref(report: &Value, action: &Value, phase: &str) -> Value {
    let id = &action[format!("{phase}_capture_id")];
    let mut value = match capture(report, action, phase) {
        Some(row) => fields(
            row,
            &[
                "capture_id",
                "action_id",
                "phase",
                "status",
                "sha256",
                "byte_length",
                "error",
            ],
        ),
        None => json!({"capture_id":id,"phase":phase,"status":"missing"}),
    };
    if !id.is_null() {
        value["read"] = tool_call(
            "scout_read_evidence",
            json!({"run_id":report["run"]["run_id"],"capture_id":id}),
        );
    }
    value["integrity"] = "not_fetched_in_report".into();
    value
}
fn artifact_ref(report: &Value, reference: &Value) -> Value {
    if reference["artifact_id"].is_null() {
        return Value::Null;
    }
    let id = &reference["artifact_id"];
    let row = list(&report["artifacts"])
        .iter()
        .find(|a| a["artifact_id"] == *id && a["run_id"] == report["run"]["run_id"]);
    let mut value = match row {
        Some(a)
            if ["kind", "sha256", "byte_length"]
                .iter()
                .all(|k| a[k] == reference[k]) =>
        {
            fields(
                a,
                &["artifact_id", "kind", "sha256", "byte_length", "status"],
            )
        }
        Some(_) => json!({"artifact_id":id,"status":"reference_mismatch"}),
        None => json!({"artifact_id":id,"status":"missing"}),
    };
    value["read"] = tool_call(
        "scout_read_evidence",
        json!({"run_id":report["run"]["run_id"],"artifact_id":id}),
    );
    value["integrity"] = "not_fetched_in_report".into();
    value
}
fn command_view(command: &Value) -> Value {
    let mut value = fields(command, &["type", "checked"]);
    for key in ["url", "value", "button"] {
        if !command[key].is_null() {
            value[key] = text(&command[key], 600);
        }
    }
    if !command["control"].is_null() {
        let c = &command["control"];
        value["control"] = json!({"control_id":c["control_id"],"role":c["role"],"name":text(&c["name"],200),
            "href":text(&c["href"],600),"rect":c["rect"],"scroll_target":c["scroll_target"],
            "form":if c["form"].is_null(){Value::Null}else{json!({"method":c["form"]["method"],"action":text(&c["form"]["action"],600)})}});
    }
    value
}
fn diagnostic_event(event: &Value) -> Value {
    let mut result = fields(
        event,
        &[
            "event_id",
            "kind",
            "request_id",
            "offset_ms",
            "status",
            "duration_ms",
            "level",
            "method",
            "resource_type",
        ],
    );
    for key in ["url", "text", "error"] {
        if !event[key].is_null() {
            result[key] = text(&event[key], 1000);
        }
    }
    result
}
fn signal(event: &Value) -> bool {
    matches!(
        event["kind"].as_str(),
        Some("console" | "page_error" | "request_failed")
    ) || event["kind"] == "response" && event["status"].as_u64().unwrap_or(0) >= 400
}
fn step(action: &Value) -> Value {
    json!({"ordinal":action["ordinal"],"action_id":action["action_id"],"state":action["state"],
        "command":command_view(&action["spec"]["command"]),"expected_result":text(&expected(action),600),
        "before_capture_id":action["before_capture_id"],"after_capture_id":action["after_capture_id"],
        "ai_verdict":action["assessment"]["verdict"],
        "full_action":tool_call("scout_get_action",json!({"run_id":action["run_id"],"action_id":action["action_id"]}))})
}
/// The persistent issue an action was registered as, with its current triage.
fn persistent_issue<'a>(report: &'a Value, action: &Value) -> Option<&'a Value> {
    list(&report["persistent_issues"])
        .iter()
        .find(|item| item["action_id"] == action["action_id"])
}
/// Known behavior is recorded like any finding but is not new work: intended
/// behavior, or a duplicate of an issue that is already tracked.
fn known_behavior(triage: &Value) -> bool {
    matches!(
        triage["decision"].as_str(),
        Some("intended_behavior" | "duplicate")
    )
}
fn triage_view(triage: &Value) -> Value {
    if triage.is_null() {
        return json!({"status":"untriaged","known_behavior":false,"decide_tool":"scout_triage_issue"});
    }
    json!({"status":triage["decision"],"known_behavior":known_behavior(triage),"decided_by":triage["actor"],"agent_id":triage["agent_id"],
        "rationale":text(&triage["rationale"],600),"duplicate_of":triage["duplicate_of"],"matched_issue_id":triage["matched_issue_id"],
        "revision":triage["revision"],"decided_at":triage["created_at"],"decide_tool":"scout_triage_issue"})
}
pub(crate) fn issue_packet(report: &Value, action: &Value) -> Value {
    let run = &report["run"];
    let prediction = &action["spec"]["prediction"];
    let assessment = &action["assessment"];
    let kind = category(action).unwrap_or("no_issue_observed");
    let before = capture(report, action, "before");
    let after = capture(report, action, "after");
    let before_obs = before.map(|c| &c["observation"]).unwrap_or(&Value::Null);
    let after_obs = after.map(|c| &c["observation"]).unwrap_or(&Value::Null);
    let command = command_view(&action["spec"]["command"]);
    let label = first(
        &[
            &command["control"]["name"],
            &command["button"],
            &command["type"],
        ],
        200,
    );
    let label = label.as_str().unwrap_or("recorded action");
    let expected = expected(action);
    let actual = first(
        &[
            &assessment["observed_result"],
            &assessment["actual"],
            &after_obs["text"],
        ],
        2500,
    );
    let is_replay = !run["config"]["replay_of"].is_null();
    let source_id = if is_replay {
        action["spec"]["replay_source_action_id"].clone()
    } else {
        action["action_id"].clone()
    };
    let review = latest_review(report, &source_id);
    let prefix: Vec<_> = owned_actions(report)
        .into_iter()
        .filter(|a| {
            a["ordinal"].as_i64().unwrap_or(i64::MAX) <= action["ordinal"].as_i64().unwrap_or(0)
        })
        .collect();
    let context = &action["spec"]["auth_context_id"];
    let same_context: Vec<_> = prefix
        .iter()
        .copied()
        .filter(|a| context.is_null() || a["spec"]["auth_context_id"] == *context)
        .collect();
    let diagnostics = list(&action["outcome"]["diagnostic_events"]);
    let signals: Vec<_> = diagnostics
        .iter()
        .filter(|e| signal(e))
        .take(12)
        .map(diagnostic_event)
        .collect();
    let mut search_terms = Vec::new();
    if let Some(name) = command["control"]["name"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        search_terms.push(json!(name));
    }
    for url in [&before_obs["url"], &after_obs["url"], &run["target_url"]] {
        if let Some(path) = url
            .as_str()
            .and_then(|s| reqwest::Url::parse(s).ok())
            .map(|u| u.path().to_owned())
            && !search_terms.contains(&json!(path))
        {
            search_terms.push(json!(path));
        }
    }
    let captures = json!({"before":capture_ref(report,action,"before"),"after":capture_ref(report,action,"after")});
    let mut gaps = Vec::new();
    for phase in ["before", "after"] {
        if captures[phase]["status"] != "available" {
            gaps.push(format!("{phase}_capture_not_available"));
        }
    }
    if expected.is_null() {
        gaps.push("expected_result_not_recorded".into());
    }
    if actual.is_null() {
        gaps.push("observed_result_not_recorded".into());
    }
    if assessment.is_null() {
        gaps.push("assessment_not_recorded".into());
    }
    if action["comparison"].is_null() {
        gaps.push("screenshot_comparison_not_recorded".into());
    }
    if action["outcome"].is_null() {
        gaps.push("completion_and_diagnostics_not_recorded".into());
    }
    let title = match kind {
        "suspected_bug" => format!("Expected result not observed: {label}"),
        "execution_problem" => format!("Execution or evidence problem: {label}"),
        "inconclusive" => format!("Uncertain result: {label}"),
        "diagnostic_signal" => format!("Browser or completion signal: {label}"),
        "observed_change" => format!("Observed change: {label}"),
        "pending_check" => format!("Check still pending: {label}"),
        _ => format!("No issue observed: {label}"),
    };
    let repros: Vec<_> = list(&report["reproductions"])
        .iter()
        .filter(|r| r["source_action_id"] == source_id)
        .map(reproduction_summary)
        .collect();
    let triage = persistent_issue(report, action)
        .map(|item| item["triage"].clone())
        .unwrap_or(Value::Null);
    let known = known_behavior(&triage);
    let repair = if kind == "suspected_bug"
        && review.is_none_or(|r| r["disposition"] != "dismissed")
        && triage["decision"] != "intended_behavior"
    {
        json!({"target_behavior":expected,"basis":prediction["source"],
            "requires_product_validation":review.is_none_or(|r|r["disposition"]!="confirmed"),
            "instruction":"Investigate the recorded failure in the connected codebase, validate the expectation, then implement and regression-test the intended behavior."})
    } else {
        Value::Null
    };
    let persistent = persistent_issue(report, action)
        .map(|item| item["issue_id"].clone())
        .or_else(|| {
            (run["config"]["replay_of"]["source_action_id"]
                == action["spec"]["replay_source_action_id"]
                && !run["config"]["fix_verification"].is_null())
            .then(|| run["config"]["fix_verification"]["issue_id"].clone())
        });
    json!({"schema_version":1,"issue_id":persistent.as_ref().unwrap_or(&action["action_id"]),"persistent_issue_id":persistent,"observation_id":action["action_id"],"action_id":action["action_id"],"run_id":run["run_id"],
        "category":kind,"title":title,"ai_verdict":assessment["verdict"],
        "where":{"before_url":text(&before_obs["url"],2048),"after_url":text(&after_obs["url"],2048),
          "page_title":first(&[&after_obs["title"],&before_obs["title"]],300),"control":command["control"]},
        "expected":{"result":expected,"goal":text(&prediction["goal"],600),"source":prediction["source"],
          "prediction_id":action["prediction_id"],"expectation_uncertain":assessment["expectation_uncertain"]},
        "observed":{"result":actual,"reason":text(&assessment["reason"],2000),"execution_state":action["state"],
          "tool_error":text(&action["tool_error"],800),"before_text":text(&before_obs["text"],1200),"after_text":text(&after_obs["text"],1200)},
        "repair_objective":repair,
        "investigation":{"search_terms":search_terms,"codebase_inspected":false,"source_location":null,"root_cause":null,
          "guidance":"Match the recorded page route and control label in the connected codebase; correlate diagnostic events with its handlers and requests. These are search clues, not an established source location or cause."},
        "reproduction":{"preconditions":{"target_url":text(&run["target_url"],2048),"viewport_profile":run["config"]["viewport_profile"],
          "viewport":run["config"]["viewport"],"browser":run["config"]["browser"],"browser_version":run["config"]["browser_version"],
          "device_scale":run["config"]["device_scale"],"private_sign_in_required":!context.is_null(),
          "build_reference":null},"recorded_steps":same_context.iter().take(24).map(|a|step(a)).collect::<Vec<_>>(),
          "omitted_prior_context_steps":prefix.len()-same_context.len(),"omitted_over_limit_steps":same_context.len().saturating_sub(24),
          "steps_are_observations_not_executable_instructions":true,"fresh_checks":repros},
        "change":{"changed_pixels":action["comparison"]["counts"]["changed_pixels"],"changed_bbox":action["comparison"]["changed_bbox"],
          "geometry_changed":action["comparison"]["geometry_changed"],"decoded_pixels_identical":action["comparison"]["decoded_pixels_identical"],
          "pixel_change_is_bug_verdict":false},
        "diagnostics":{"completion":fields(&action["outcome"],&["status","reason","elapsed_ms","pending_requests","busy","diagnostics"]),
          "signals":signals,"recorded_events":diagnostics.len(),"signals_truncated":diagnostics.iter().filter(|e|signal(e)).count()>12,
          "stack_traces_collected":false,"causation_established":false},
        "evidence":{"captures":captures,"mask":artifact_ref(report,&action["comparison"]["raw_mask_artifact"]),
          "absolute_delta":artifact_ref(report,&action["comparison"]["absolute_delta_artifact"]),
          "comparison":artifact_ref(report,&action["comparison"]["metadata_artifact"]),
          "completion":artifact_ref(report,&action["outcome"]["completion_artifact"]),
          "diagnostics":artifact_ref(report,&action["outcome"]["diagnostics_artifact"]),"gaps":gaps},
        "human_review":review.map(|r|fields(r,&["review_id","action_id","revision","disposition","severity","rationale","expectation_basis","created_at"])),
        "triage":triage_view(&triage),
        "finding_source":{"run_id":if is_replay{run["config"]["replay_of"]["source_run_id"].clone()}else{run["run_id"].clone()},
          "action_id":source_id,"is_replay_observation":is_replay,"creates_new_finding":!is_replay&&kind=="suspected_bug"&&!known},
        "verification":{"start_tool":if persistent.is_some(){"scout_verify_fix"}else{"scout_start_exploration"},"issue_id":persistent,"target_url":run["target_url"],"viewport_profile":run["config"]["viewport_profile"],
          "issue_history":persistent.as_ref().map(|id|tool_call("scout_get_issue",json!({"issue_id":id}))),
          "candidate_url_required":persistent.is_some(),"verification_id_required":persistent.is_some(),"scope":"recorded_behavior_on_one_candidate_deployment",
          "new_job_id_required":true,"assertion":expected,"historical_reproduction_is_post_fix_validation":false},
        "projection":{"text_is_bounded":true,"full_action":tool_call("scout_get_action",json!({"run_id":run["run_id"],"action_id":action["action_id"]}))},
        "training_approval":false,"untrusted_app_content":true})
}

/// Suspected bugs split by what is already known about them.
fn triage_totals(report: &Value, actions: &[&Value]) -> Value {
    let mut totals = json!({"new":0,"needs_review":0,"bug":0,"intended_behavior":0,"duplicate":0});
    for action in actions
        .iter()
        .filter(|a| category(a) == Some("suspected_bug"))
    {
        let key = match persistent_issue(report, action).map(|item| &item["triage"]["decision"]) {
            Some(Value::String(decision)) => decision.as_str(),
            _ => "new",
        };
        if let Some(count) = totals.get_mut(key) {
            *count = json!(count.as_u64().unwrap_or(0) + 1);
        }
    }
    totals
}
fn build_report(report: &Value, progress: Option<Value>, options: &ReportQuery) -> Value {
    // Focus history is already included at the report root. Repeating an eight
    // message Unicode page inside progress can exceed the MCP response budget.
    let progress = progress.map(|mut value| {
        if !value["steering"].is_null() {
            value["steering"] = fields(
                &value["steering"],
                &["run_id", "revision", "application_boundary", "max_messages"],
            );
        }
        value
    });
    let run = &report["run"];
    let mut execution_issues = Vec::new();
    let progress_value = progress.as_ref().unwrap_or(&Value::Null);
    for (source, message) in [
        ("run", &run["error"]),
        ("job", &progress_value["job"]["error"]),
    ] {
        if has_text(message)
            && !execution_issues
                .iter()
                .any(|e: &Value| e["message"] == text(message, 800))
        {
            execution_issues.push(json!({"source":source,"scope":"qa_execution","message":text(message,800),"is_application_bug":false}));
        }
    }
    let actions = owned_actions(report);
    let mut categorized = Vec::new();
    let mut totals = serde_json::Map::new();
    for action in &actions {
        if let Some(kind) = category(action) {
            let count = totals.get(kind).and_then(Value::as_u64).unwrap_or(0) + 1;
            totals.insert(kind.into(), json!(count));
            if options.include_changes.unwrap_or(true) || kind != "observed_change" {
                categorized.push(*action);
            }
        }
    }
    categorized.sort_by_key(|a| (priority(a), a["ordinal"].as_i64().unwrap_or(i64::MAX)));
    let offset = options.offset.unwrap_or(0);
    let limit = options.limit.unwrap_or(4);
    let latest = list(&report["events"]).last();
    let mut result = json!({"schema_version":1,"report_state":if terminal(&run["lifecycle"]){"run_finished"}else{"partial"},
      "execution_finished":terminal(&run["lifecycle"]),"run":fields(run,&["run_id","target_url","lifecycle","created_at","finished_at","error"]),
      "snapshot":{"id":snapshot_id(report),"generated_at":chrono::Utc::now().to_rfc3339(),"run_event_seq":run["event_seq"],"latest_event_id":latest.map(|e|&e["event_id"]),
        "human_review_revision":list(&report["finding_reviews"]).iter().filter_map(|r|r["revision"].as_u64()).max(),
        "reproduction_results_can_change":true,"progress_observed_before_report":true},
      "environment":fields(&run["config"],&["execution_mode","viewport_profile","viewport","browser","browser_version","playwright_version"]),
      "summary":{"actions_recorded":actions.len(),"assessed_actions":actions.iter().filter(|a|!a["assessment"].is_null()).count(),
        "no_issue_observed_actions":actions.iter().filter(|a|a["assessment"]["verdict"]=="no_issue_observed").count(),
        "categories":totals,"stop_reason":run["config"]["stop_reason"],"total_items":categorized.len(),
        "triage":triage_totals(report,&actions),
        "execution_issue_count":execution_issues.len()},
      "execution_issues":execution_issues,
      "progress":progress,"steering":steering_summary(&report["steering"]),"usage":report["model_usage"],"fix_verification":report["fix_verification"],
      "automatic_checks":list(&report["automatic_reproductions"]).iter().map(automatic_summary).collect::<Vec<_>>(),
      "issues":[],"pagination":{"offset":offset,"requested_limit":limit,"returned":0,"total":categorized.len(),
        "has_more":false,"next_offset":null,"order":"category_priority_then_recorded_ordinal"},
      "coverage_complete":false,"codebase_inspected":false,"training_approval":false,"untrusted_app_content":true,
      "limitations":["Behavioral expectations are recorded hypotheses unless separately validated by a human.",
        "Observed screenshot changes and browser errors alone do not establish a product defect.",
        "No codebase, build reference or root cause was inspected. A connected coding agent must establish those.",
        "Private sign-in inputs, HTTP bodies/headers and stack traces are not recorded.",
        "Evidence metadata is included here; fetch referenced bytes to verify their length and hash.",
        "This is a bounded snapshot. Pending work, reproduction and human review may update after this read."]});
    for action in categorized.iter().skip(offset).take(limit) {
        result["issues"]
            .as_array_mut()
            .unwrap()
            .push(issue_packet(report, action));
        result["markdown"] = json!(markdown(&result));
        if result.to_string().len() > 120 * 1024 {
            result["issues"].as_array_mut().unwrap().pop();
            break;
        }
    }
    let returned = list(&result["issues"]).len();
    let more = offset + returned < categorized.len();
    result["pagination"]["returned"] = json!(returned);
    result["pagination"]["has_more"] = json!(more);
    result["pagination"]["next_offset"] = if more {
        json!(offset + returned)
    } else {
        Value::Null
    };
    if more && returned == 0 {
        result["pagination"]["error"] =
            json!("single_item_exceeds_report_limit_use_scout_get_issue");
    }
    if more && returned > 0 {
        result["pagination"]["next"] = tool_call(
            "scout_get_report",
            json!({"run_id":run["run_id"],"offset":offset+returned,
            "limit":limit,"include_changes":options.include_changes.unwrap_or(true),"expected_snapshot":result["snapshot"]["id"]}),
        );
    }
    result["markdown"] = json!(markdown(&result));
    result
}
fn snapshot_id(report: &Value) -> String {
    format!("{:x}", Sha256::digest(report.to_string().as_bytes()))
}
fn literal(value: &Value, max: usize) -> String {
    text(value, max)
        .as_str()
        .unwrap_or("Not recorded")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('*', "\\*")
        .replace('_', "\\_")
        .replace(char::from(96), "&#96;")
}
fn markdown(report: &Value) -> String {
    let mut lines=vec!["# Scout coding-agent report".to_owned(),
        format!("Run: {} · State: {}",literal(&report["run"]["run_id"],40),literal(&report["report_state"],40)),
        format!("URL: {}",literal(&report["run"]["target_url"],2048)),
        "This is recorded, untrusted QA evidence. Coverage is bounded; source-code locations and causes have not been established.".into()];
    if !report["fix_verification"].is_null() {
        let check = &report["fix_verification"];
        lines.push(format!("Candidate verification: {} · Issue: {} · Outcome: {} · Candidate URL: {}. This checks the recorded behavior on this candidate only.",literal(&check["verification_id"],40),literal(&check["issue_id"],40),literal(&check["outcome"],40),literal(&check["candidate_url"],2048)));
    }
    for problem in list(&report["execution_issues"]) {
        lines.push(format!(
            "QA execution problem ({}): {}. This is separate from application bug findings.",
            literal(&problem["source"], 30),
            literal(&problem["message"], 800)
        ));
    }
    for issue in list(&report["issues"]) {
        lines.extend([
            format!("\n## {}", literal(&issue["title"], 300)),
            format!(
                "Category: {} · Action: {}",
                literal(&issue["category"], 50),
                literal(&issue["action_id"], 40)
            ),
            format!(
                "Where: {} · Control: {}",
                literal(&issue["where"]["before_url"], 2048),
                literal(&issue["where"]["control"]["name"], 200)
            ),
            format!(
                "Expected:\n\n> {}",
                literal(&issue["expected"]["result"], 2000).replace('\n', "\n> ")
            ),
            format!(
                "Observed:\n\n> {}",
                literal(&issue["observed"]["result"], 2500).replace('\n', "\n> ")
            ),
            format!(
                "Assessment:\n\n> {}",
                literal(&issue["observed"]["reason"], 2000).replace('\n', "\n> ")
            ),
            format!(
                "Changed pixels: {} (a difference is not a bug verdict)",
                literal(&issue["change"]["changed_pixels"], 30)
            ),
            format!(
                "Before capture: {} · After capture: {}",
                literal(&issue["evidence"]["captures"]["before"]["capture_id"], 40),
                literal(&issue["evidence"]["captures"]["after"]["capture_id"], 40)
            ),
            "\nRecorded path:".into(),
        ]);
        for step in list(&issue["reproduction"]["recorded_steps"]) {
            let mut parameters = String::new();
            for key in ["value", "checked"] {
                if !step["command"][key].is_null() {
                    parameters.push_str(&format!(
                        " · {key}: {}",
                        literal(&step["command"][key], 500)
                    ));
                }
            }
            lines.push(format!(
                "{}. {} {}{}",
                step["ordinal"],
                literal(&step["command"]["type"], 40),
                literal(
                    &first(
                        &[&step["command"]["control"]["name"], &step["command"]["url"]],
                        200
                    ),
                    200
                ),
                parameters
            ));
        }
        lines.push(format!(
            "\nCompletion: {} · HTTP errors: {} · Request failures: {} · Browser errors: {}",
            literal(&issue["diagnostics"]["completion"]["status"], 40),
            literal(
                &issue["diagnostics"]["completion"]["diagnostics"]["http_errors"],
                30
            ),
            literal(
                &issue["diagnostics"]["completion"]["diagnostics"]["request_failures"],
                30
            ),
            literal(
                &issue["diagnostics"]["completion"]["diagnostics"]["console_errors"],
                30
            )
        ));
        for signal in list(&issue["diagnostics"]["signals"]).iter().take(8) {
            lines.push(format!("Diagnostic observation: {}", literal(signal, 1800)));
        }
        lines.push(format!(
            "\nHuman disposition: {}",
            literal(&issue["human_review"]["disposition"], 40)
        ));
        lines.push(format!(
            "Triage: {} (decided by {}){}",
            literal(&issue["triage"]["status"], 40),
            literal(&issue["triage"]["decided_by"], 20),
            if issue["triage"]["known_behavior"] == true {
                " · known behavior, not a new finding"
            } else {
                ""
            }
        ));
        for check in list(&issue["reproduction"]["fresh_checks"]) {
            lines.push(format!(
                "Fresh reproduction: {} · Replay run: {}",
                literal(&check["result"]["outcome"], 40),
                literal(&check["replay_run_id"], 40)
            ));
        }
        if !issue["repair_objective"].is_null() {
            lines.push(format!(
                "\nBehavior to validate and implement: {}",
                literal(&issue["repair_objective"]["target_behavior"], 2000)
            ));
        }
        lines.push(format!(
            "\nCode search clues: {}",
            literal(&issue["investigation"]["search_terms"], 1200)
        ));
        if issue["triage"]["known_behavior"] == true {
            lines.push("Known behavior: no fix is requested. Change the triage with scout_triage_issue if this is wrong.".into());
        } else {
            lines.push("Deploy the candidate fix and start a new run to regression-test it; a historical reproduction does not validate a later change.".into());
        }
    }
    lines.push(format!(
        "\nReturned {} of {} matching observations. Follow pagination.next_offset when present.",
        list(&report["issues"]).len(),
        report["pagination"]["total"]
    ));
    lines.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_focus_history_does_not_duplicate_inside_report_progress() {
        let mut report = fixture();
        report["actions"] = json!([]);
        let messages:Vec<Value>=(1..=32).map(|revision|json!({"revision":revision,"focus":"🙂".repeat(2000),"steering_id":Uuid::new_v4(),"status":"applied","decision_id":Uuid::new_v4()})).collect();
        report["steering"] = json!({"run_id":report["run"]["run_id"],"revision":32,"messages":messages,"active_focus":messages.last(),"application_boundary":"next_planning_decision","max_messages":32});
        let progress = json!({"steering":steering_summary(&report["steering"])});
        let page = build_report(&report, Some(progress), &ReportQuery::default());
        assert!(page.to_string().len() <= MAX_JSON);
        assert_eq!(list(&page["steering"]["messages"]).len(), 8);
        assert_eq!(page["steering"]["next_offset"], 8);
        assert!(page["progress"]["steering"].get("messages").is_none());
        assert_eq!(page["progress"]["steering"]["revision"], 32);
    }
    fn fixture() -> Value {
        let run_id = Uuid::new_v4();
        let mut report = json!({"run":{"run_id":run_id,"target_url":"http://app.test/drafts","lifecycle":"completed","event_seq":8,
            "config":{"runtime_version":"explorer-v1","replay_of":null,"viewport_profile":"mobile","viewport":{"width":390,"height":844},
                "browser":"chromium","browser_version":"test","device_scale":1,"stop_reason":"action_budget_reached"}},
            "actions":[],"captures":[],"artifacts":[],"events":[],"reproductions":[],"finding_reviews":[]});
        for (ordinal, verdict, pixels) in [(1, "no_issue_observed", 120), (2, "suspect", 0)] {
            let action_id = Uuid::new_v4();
            let before = Uuid::new_v4();
            let after = Uuid::new_v4();
            report["actions"].as_array_mut().unwrap().push(json!({"action_id":action_id,"run_id":run_id,"ordinal":ordinal,"state":"completed",
              "prediction_id":Uuid::new_v4(),"before_capture_id":before,"after_capture_id":after,
              "spec":{"command":if ordinal==1{json!({"type":"navigate","url":"http://app.test/drafts"})}else{json!({"type":"click","control":{"role":"button","name":"Save draft","control_id":"recorded-control","rect":{"x":10,"y":20,"width":50,"height":20}}})},
                "prediction":{"source":"model","goal":"Save a draft","expected_result":if ordinal==1{"Draft editor opens."}else{"The draft status changes to Saved."}}},
              "assessment":{"verdict":verdict,"observed_result":"Ready","reason":"Recorded comparison with the frozen expectation.","expectation_uncertain":false,"confirmed_bug":false},
              "comparison":{"counts":{"changed_pixels":pixels},"geometry_changed":false,"decoded_pixels_identical":pixels==0},
              "outcome":{"status":"settled","diagnostics":{"http_errors":0,"request_failures":0,"console_errors":0},"diagnostic_events":[]}}));
            for (phase, id) in [("before", before), ("after", after)] {
                report["captures"].as_array_mut().unwrap().push(json!({"capture_id":id,"run_id":run_id,"action_id":action_id,
                    "phase":phase,"status":"available","sha256":"a".repeat(64),"byte_length":200,
                    "observation":{"url":"http://app.test/drafts","title":"Draft editor","text":"Ready","viewport":{"width":390,"height":844}}}));
            }
        }
        report
    }
    #[test]
    fn zero_pixel_failure_has_expected_actual_path_and_repair_context() {
        let report = fixture();
        let action = &report["actions"][1];
        let issue = issue_packet(&report, action);
        assert_eq!(issue["category"], "suspected_bug");
        assert_eq!(issue["change"]["changed_pixels"], 0);
        assert_eq!(issue["where"]["control"]["name"], "Save draft");
        assert_eq!(issue["where"]["before_url"], "http://app.test/drafts");
        assert_eq!(
            issue["expected"]["result"],
            "The draft status changes to Saved."
        );
        assert_eq!(issue["observed"]["result"], "Ready");
        assert_eq!(
            issue["repair_objective"]["target_behavior"],
            issue["expected"]["result"]
        );
        assert_eq!(
            issue["reproduction"]["recorded_steps"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            issue["reproduction"]["preconditions"]["viewport_profile"],
            "mobile"
        );
        assert_eq!(
            issue["evidence"]["captures"]["before"]["read"]["arguments"]["capture_id"],
            action["before_capture_id"]
        );
        assert!(issue["investigation"]["source_location"].is_null());
        assert!(issue["investigation"]["root_cause"].is_null());
        assert_eq!(
            issue["verification"]["historical_reproduction_is_post_fix_validation"],
            false
        );
    }
    #[test]
    fn normal_changes_uncertainty_and_browser_errors_are_not_confirmed_bugs() {
        let mut report = fixture();
        assert_eq!(category(&report["actions"][0]), Some("observed_change"));
        assert!(issue_packet(&report, &report["actions"][0])["repair_objective"].is_null());
        report["actions"][1]["assessment"]["expectation_uncertain"] = json!(true);
        assert_eq!(category(&report["actions"][1]), Some("inconclusive"));
        report["actions"][0]["outcome"]["diagnostics"]["http_errors"] = json!(1);
        report["actions"][0]["outcome"]["diagnostic_events"] = json!([{"kind":"response","url":"http://app.test/api/drafts","status":500,"request_id":"recorded-request"}]);
        let issue = issue_packet(&report, &report["actions"][0]);
        assert_eq!(issue["category"], "diagnostic_signal");
        assert_eq!(issue["diagnostics"]["signals"][0]["status"], 500);
        assert_eq!(issue["diagnostics"]["causation_established"], false);
        assert!(issue["repair_objective"].is_null());
    }
    #[test]
    fn latest_human_dismissal_suppresses_repair_advice_and_replay_keeps_source_identity() {
        let mut report = fixture();
        let id = report["actions"][1]["action_id"].clone();
        report["finding_reviews"] = json!([{"action_id":id,"revision":1,"disposition":"confirmed"},{"action_id":id,"revision":2,"disposition":"dismissed"}]);
        let issue = issue_packet(&report, &report["actions"][1]);
        assert_eq!(issue["human_review"]["disposition"], "dismissed");
        assert!(issue["repair_objective"].is_null());
        let source = Uuid::new_v4();
        report["run"]["config"]["replay_of"] =
            json!({"source_run_id":source,"source_action_id":id});
        report["actions"][1]["spec"]["replay_source_action_id"] = id.clone();
        let replay = issue_packet(&report, &report["actions"][1]);
        assert_eq!(replay["finding_source"]["run_id"], source.to_string());
        assert_eq!(replay["finding_source"]["action_id"], id);
        assert_eq!(replay["finding_source"]["creates_new_finding"], false);
    }
    #[test]
    fn absent_evidence_and_private_contexts_remain_explicit_and_markdown_escapes_page_text() {
        let mut report = fixture();
        report["run"]["config"]["auth_contexts"] = json!([{"session_id":"never-transfer-session"}]);
        report["actions"][1]["spec"]["auth_context_id"] = json!("opaque-context");
        report["actions"][1]["assessment"]["observed_result"] = json!("<script>untrusted</script>");
        report["captures"] = json!([]);
        let issue = issue_packet(&report, &report["actions"][1]);
        assert_eq!(
            issue["reproduction"]["preconditions"]["private_sign_in_required"],
            true
        );
        assert_eq!(issue["reproduction"]["omitted_prior_context_steps"], 1);
        assert_eq!(issue["evidence"]["captures"]["before"]["status"], "missing");
        assert!(!issue.to_string().contains("never-transfer-session"));
        let output = build_report(&report, None, &ReportQuery::default());
        assert!(!output["markdown"].as_str().unwrap().contains("<script>"));
        assert!(
            output["markdown"]
                .as_str()
                .unwrap()
                .contains("&lt;script&gt;")
        );
        assert_eq!(output["coverage_complete"], false);
    }
    #[test]
    fn report_pages_are_bounded_complete_and_have_snapshot_bound_continuations() {
        let mut report = fixture();
        let sample = report["actions"][1].clone();
        report["actions"] = json!([]);
        for ordinal in 1..=12 {
            let mut a = sample.clone();
            a["action_id"] = json!(Uuid::new_v4());
            a["ordinal"] = json!(ordinal);
            a["assessment"]["observed_result"] = json!("Observed result ".repeat(800));
            a["spec"]["prediction"]["expected_result"] = json!("Expected behavior ".repeat(800));
            report["actions"].as_array_mut().unwrap().push(a);
        }
        let mut offset = 0;
        let mut ids = Vec::new();
        loop {
            let page = build_report(
                &report,
                None,
                &ReportQuery {
                    offset: Some(offset),
                    limit: Some(10),
                    ..Default::default()
                },
            );
            assert!(page.to_string().len() <= MAX_JSON);
            let items = list(&page["issues"]);
            assert!(!items.is_empty());
            ids.extend(items.iter().map(|i| i["action_id"].clone()));
            if page["pagination"]["has_more"] == false {
                break;
            }
            assert_eq!(
                page["pagination"]["next"]["arguments"]["expected_snapshot"],
                page["snapshot"]["id"]
            );
            offset = page["pagination"]["next_offset"].as_u64().unwrap() as usize;
        }
        assert_eq!(ids.len(), 12);
        let previous = snapshot_id(&report);
        report["actions"][0]["assessment"]["reason"] = json!("Changed assessment");
        assert_ne!(snapshot_id(&report), previous);
    }
    #[test]
    fn active_and_empty_reports_do_not_claim_complete_coverage_or_fake_progress() {
        let mut report = fixture();
        report["run"]["lifecycle"] = json!("active");
        let page = build_report(
            &report,
            None,
            &ReportQuery {
                include_changes: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(page["report_state"], "partial");
        assert_eq!(page["execution_finished"], false);
        assert_eq!(page["pagination"]["total"], 1);
        let progress = progress_view(
            &json!({"job":{"job_id":Uuid::new_v4(),"status":"queued"},"access_requests":[]}),
            &Selection {
                job_id: Some(Uuid::new_v4()),
                run_id: None,
            },
        );
        assert_eq!(progress["phase"], "queued");
        assert_eq!(progress["report_available"], false);
        assert!(progress["progress_percent"].is_null());
        assert_eq!(progress["next"]["report"]["name"], "scout_get_report");
    }
    #[test]
    fn delivery_failure_is_explicit_without_reclassifying_a_successful_app_action() {
        let mut report = fixture();
        report["actions"][1]["assessment"]["verdict"] = json!("no_issue_observed");
        report["actions"][1]["assessment"]["observed_result"] = json!("Saved");
        let progress =
            json!({"job":{"status":"failed","error":"ClickHouse export failed with HTTP 500"}});
        let page = build_report(
            &report,
            Some(progress),
            &ReportQuery {
                include_changes: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(page["summary"]["execution_issue_count"], 1);
        assert_eq!(page["execution_issues"][0]["is_application_bug"], false);
        assert_eq!(page["execution_issues"][0]["source"], "job");
        assert_eq!(page["pagination"]["total"], 0);
        assert!(
            page["markdown"]
                .as_str()
                .unwrap()
                .contains("ClickHouse export failed")
        );
        assert_eq!(page["progress"]["job"]["status"], "failed");
    }
    #[tokio::test]
    async fn report_arguments_and_new_routes_require_scope_before_storage() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let state = AppState::new(None, "report_test_local_token_1234567890123456789").unwrap();
        let id = Uuid::new_v4();
        for input in [
            json!({}),
            json!({"job_id":id,"run_id":id}),
            json!({"run_id":Uuid::nil()}),
            json!({"run_id":id,"limit":11}),
            json!({"run_id":id,"expected_snapshot":"bad"}),
            json!({"run_id":id,"source_path":"/private/file"}),
        ] {
            assert!(report_tool(&state, input).await.is_err());
        }
        for suffix in [
            "report",
            "progress",
            "issues/00000000-0000-4000-8000-000000000001",
        ] {
            let request = Request::builder()
                .uri(format!("/v1/runs/{id}/{suffix}"))
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                crate::router(state.clone())
                    .oneshot(request)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            progress_tool(&state, json!({"job_id":id}))
                .await
                .unwrap()
                .structured_content
                .unwrap()["http_status"],
            503
        );
    }
}
