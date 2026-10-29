//! MCP/HTTP tool metadata, separate from request dispatch and evidence reads.
use rmcp::model::Tool;
use serde_json::{Value, json};

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn id_schema() -> Value {
    json!({"type":"string","format":"uuid","description":"A non-nil UUID. Reuse the same job UUID when retrying a command."})
}
fn choice(values: &[&str]) -> Value {
    json!({"type":"string","enum":values})
}
fn tool(
    name: &str,
    description: &str,
    input: Value,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
) -> Tool {
    serde_json::from_value(json!({"name":name,"description":description,"inputSchema":input,"outputSchema":{"type":"object"},
        "annotations":{"readOnlyHint":read_only,"destructiveHint":destructive,"idempotentHint":idempotent,"openWorldHint":open_world}})).expect("static tool schema")
}
pub fn tools() -> Vec<Tool> {
    let run = || schema(json!({"run_id":id_schema()}), &["run_id"]);
    let history_schema = || {
        schema(
            json!({"domain":{"type":"string","maxLength":253},"url":{"type":"string","maxLength":2048},"project_id":id_schema(),"task_id":id_schema(),"agent_id":id_schema(),"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":50}}),
            &[],
        )
    };
    let mut issue_schema = schema(
        json!({"issue_id":id_schema(),"run_id":id_schema(),"action_id":id_schema(),"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":10},"expected_revision":{"type":"integer","minimum":1}}),
        &[],
    );
    issue_schema["oneOf"] = json!([{"required":["issue_id"],"not":{"anyOf":[{"required":["run_id"]},{"required":["action_id"]}]}},{"required":["run_id","action_id"],"not":{"required":["issue_id"]}}]);
    vec![
        tool(
            "scout_get_steering",
            "Read a run's versioned testing focus and acknowledgements. Follow next_offset for older pages (newest page first). Applied means included in a planning decision, not proof of coverage. No model call.",
            schema(
                json!({"run_id":id_schema(),"offset":{"type":"integer","minimum":0,"maximum":32},"limit":{"type":"integer","minimum":1,"maximum":8}}),
                &["run_id"],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_steer_run",
            "Replace an active exploration's testing focus at its next planning decision. Read the current revision first. Save steering_id and retry identical inputs after uncertainty. Empty focus clears it. Does not alter in-flight actions, frozen replay paths, budgets or safety policy. Poll scout_get_steering for applied, superseded or not_applied acknowledgement.",
            schema(
                json!({"run_id":id_schema(),"steering_id":id_schema(),"expected_revision":{"type":"integer","minimum":0,"maximum":32},"focus":{"type":"string","maxLength":2000}}),
                &["run_id", "steering_id", "expected_revision", "focus"],
            ),
            false,
            true,
            true,
            false,
        ),
        tool(
            "scout_list_issues",
            "List persistent workspace issues and candidate verification status. Search title/URL; follow next_offset. Original suspicions and human review remain separate.",
            schema(
                json!({"query":{"type":"string","maxLength":200},"outcome":choice(&["unverified","running","resolved","still_reproducible","blocked","inconclusive"]),"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":50}}),
                &[],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_verify_fix",
            "Verify the frozen behavior of an issue on a candidate URL in a fresh browser. Can change the controlled app and consume model usage. Save verification_id before sending and reuse identical inputs after uncertainty. Results are resolved, still_reproducible, blocked or inconclusive for this candidate only.",
            schema(
                json!({"issue_id":id_schema(),"verification_id":id_schema(),"candidate_url":{"type":"string","maxLength":2048},"deployment_ref":{"type":"string","minLength":1,"maxLength":200},"auth_mode":choice(&["auto","public"]),"session_id":id_schema(),"project_id":id_schema(),"task_id":id_schema()}),
                &["issue_id", "verification_id", "candidate_url"],
            ),
            false,
            true,
            true,
            true,
        ),
        tool(
            "scout_get_verification",
            "Read candidate verification progress/outcome, frozen original expectation, both evidence sets and separately attributed usage. No model call. Follow the issue tool for the full history.",
            schema(json!({"verification_id":id_schema()}), &["verification_id"]),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_whoami",
            "Read the authenticated agent, workspace, credential reference and scopes. Contains no secret.",
            schema(json!({}), &[]),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_list_sessions",
            "Search the complete accessible private run history by exact domain/URL, project, task or submitting agent. Follow pagination.next_offset; new runs may move offsets.",
            history_schema(),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_domain_summary",
            "Read the latest 20 accessible runs for a required exact domain, total matching history and coverage caveats. Historical observations are not a fresh verification.",
            history_schema(),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_new_request_id",
            "Allocate a command UUID when the client cannot generate one. Save and reuse it for command retries.",
            schema(json!({}), &[]),
            true,
            false,
            false,
            false,
        ),
        tool(
            "scout_status",
            "Inspect Scout readiness, configured provider availability, operator scope and defaults. No model call.",
            schema(json!({}), &[]),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_list_runs",
            "List a filtered slice of the latest 50 owned runs. Results explicitly state this recent-list scope.",
            schema(
                json!({"limit":{"type":"integer","minimum":1,"maximum":50},"lifecycle":choice(&["active","completed","failed","interrupted","blocked","cancelled"])}),
                &[],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_start_exploration",
            "Queue URL-only exploration. Can interact with and change the controlled target app; uses Scout's configured model and may incur usage. job_id is required for safe retries; same UUID and inputs reuse the original admission. No brief required.",
            schema(
                json!({"job_id":id_schema(),"project_id":id_schema(),"task_id":id_schema(),"url":{"type":"string","maxLength":2048},"viewport_profile":choice(&["desktop","tablet","mobile"]),"auth_mode":choice(&["auto","sign_in","public"]),"session_id":id_schema(),"auto_reproduce":{"type":"boolean"}}),
                &["job_id", "url"],
            ),
            false,
            true,
            true,
            true,
        ),
        tool(
            "scout_get_job",
            "Read one durable browser job by UUID, including a linked run, settings revision, errors and cancellation acknowledgement. Works outside the latest-50 list.",
            schema(json!({"job_id":id_schema()}), &["job_id"]),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_run",
            "Read a compact run summary, action IDs, usage and pending sign-in blockers. Missing evidence or usage stays explicit.",
            run(),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_progress",
            "Check lightweight durable progress for exactly one job_id or run_id, then continue other work. Returns phase, action counts, human blockers, event cursor and the report tool to call later. No model call or blocking wait.",
            schema(json!({"job_id":id_schema(),"run_id":id_schema()}), &[]),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_report",
            "Return a coding-agent handoff for exactly one job_id or run_id: bugs, observed changes and uncertain checks with expected versus actual behavior, page/control location, reproduction steps, diagnostics and evidence IDs. Can be partial while work continues. Follow next_offset to retrieve every item; no new inference.",
            schema(
                json!({"job_id":id_schema(),"run_id":id_schema(),"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":10},"include_changes":{"type":"boolean"},"expected_snapshot":{"type":"string","minLength":64,"maxLength":64}}),
                &[],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_issue",
            "Read a persistent issue by issue_id: original repair handoff, occurrences, candidate checks, evidence and usage. History pages use offset/limit and expected_revision. Legacy run_id plus action_id still reads one recorded observation. Source locations and root causes are not inferred.",
            issue_schema,
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_list_findings",
            "Read original AI candidates and latest human-review status. Replays do not create duplicate findings; no automatic confirmation.",
            schema(
                json!({"run_id":id_schema(),"status":choice(&["all","needs_review","confirmed","dismissed"])}),
                &["run_id"],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_action",
            "Inspect one recorded action, frozen expectation, assessment, before/after evidence metadata and sampled-frame references.",
            schema(
                json!({"run_id":id_schema(),"action_id":id_schema()}),
                &["run_id", "action_id"],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_graph",
            "Inspect a bounded slice of recorded states, transitions, frontier and decisions. The offset applies to each array; each has its own total and has_more flag. Scores are uncalibrated.",
            schema(
                json!({"run_id":id_schema(),"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":50}}),
                &["run_id"],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_events",
            "Poll ordered durable run events after a sequence number. Follow next_after_seq while has_more is true; no simulated progress or model calls.",
            schema(
                json!({"run_id":id_schema(),"after_seq":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}}),
                &["run_id"],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_read_evidence",
            "Read a recorded capture PNG or artifact for this run. Supply exactly one capture_id or artifact_id. PNGs return an MCP image block; bytes are verified against recorded length/SHA256. Private login screens are excluded.",
            schema(
                json!({"run_id":id_schema(),"capture_id":id_schema(),"artifact_id":id_schema()}),
                &["run_id"],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_reproduce_candidate",
            "Queue the existing fresh-browser suspect reproduction. Can change the controlled target app and may consume configured model usage. Stable job_id required; server eligibility/deduplication rules still apply.",
            schema(
                json!({"job_id":id_schema(),"source_action_id":id_schema()}),
                &["job_id", "source_action_id"],
            ),
            false,
            true,
            true,
            true,
        ),
        tool(
            "scout_cancel_work",
            "Request durable cancellation of a job, run, or a source run's automatic checks. In-flight model usage may still settle; recorded evidence is retained.",
            schema(
                json!({"kind":choice(&["job","run","automatic_checks"]),"id":id_schema()}),
                &["kind", "id"],
            ),
            false,
            true,
            true,
            true,
        ),
        tool(
            "scout_usage",
            "Inspect owned provider-reported token/cost totals. Missing usage remains unknown; model subscriptions are not inferred from token counts.",
            schema(json!({}), &[]),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_access_requests",
            "List pending user sign-in handoffs, optionally for one run. Returns no credentials, private frames, leases or saved-session material.",
            schema(json!({"run_id":id_schema()}), &[]),
            true,
            false,
            true,
            false,
        ),
    ]
}
