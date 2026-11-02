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
    // A run's own model. Omitted: the project's model, else the saved default.
    let model = || {
        json!({"type":"object","description":"This run's model instead of the project's or the default. free_only (default true) keeps OpenRouter on free model IDs. navigation_model: omit to inherit, null for none.",
            "properties":{"provider":choice(&["openai","anthropic","openrouter","meta"]),"model":{"type":"string","minLength":1,"maxLength":200},"provider_key_id":{"type":"string","description":"Saved provider key UUID or demo; omit to use the configured default. Never send an API secret.","anyOf":[{"const":"demo"},{"format":"uuid"}]},"free_only":{"type":"boolean"},
                "navigation_model":{"type":["object","null"],"properties":{"provider":choice(&["openai","anthropic","openrouter","meta"]),"model":{"type":"string","minLength":1,"maxLength":200}},"required":["provider","model"],"additionalProperties":false}},
            "required":["provider","model"],"additionalProperties":false})
    };
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
            "List persistent workspace issues with their triage and candidate verification status. triage=open returns untriaged, needs-review and bug issues; known intended behavior and duplicates are listed only when asked for. Search title/URL; follow next_offset.",
            schema(
                json!({"query":{"type":"string","maxLength":200},"outcome":choice(&["unverified","running","resolved","still_reproducible","blocked","inconclusive"]),"triage":choice(&["open","untriaged","needs_review","bug","intended_behavior","duplicate"]),"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":50}}),
                &[],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_verify_fix",
            "Verify the frozen behavior of an issue on a candidate URL in a fresh browser. Can change data on the candidate site and consume model usage. Save verification_id before sending and reuse identical inputs after uncertainty. Results are resolved, still_reproducible, blocked or inconclusive for this candidate only.",
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
            "scout_triage_issue",
            "Decide what an issue is: bug (keep checking it), intended_behavior (later runs record the same page and control as known behavior), duplicate (duplicate_of names the issue it repeats) or needs_review. Give a rationale grounded in the evidence or product requirements. Decisions are append-only and shown to the user as made by an agent; an agent cannot replace a person's decision. Pass expected_revision from the issue's triage to avoid overwriting a newer decision.",
            schema(
                json!({"issue_id":id_schema(),"decision":choice(&["bug","intended_behavior","duplicate","needs_review"]),"rationale":{"type":"string","minLength":1,"maxLength":2000},"duplicate_of":id_schema(),"expected_revision":{"type":"integer","minimum":0}}),
                &["issue_id", "decision", "rationale"],
            ),
            false,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_app_map",
            "Read the app map carried between runs for one app scope (an app origin, screen size and sign-in state): states by depth from the entry page, where each control led, verdicts, and controls no run has tried yet. Pass scope_id, or origin with optional viewport_profile and auth_scope for the most recent matching scope. A state is a page template plus the controls it offers; exact screens stay per-run evidence. No model call.",
            schema(
                json!({"scope_id":id_schema(),"origin":{"type":"string","maxLength":2048},"viewport_profile":choice(&["desktop","tablet","mobile"]),"auth_scope":choice(&["public","signed_in"]),"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":100}}),
                &[],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_compare_run",
            "Compare a run's map with earlier runs of the same app scope: states and transitions seen for the first time, states the previous run reached but this one did not, controls that now lead somewhere else, and verdict changes such as a former no-issue transition that is now suspect. No model call.",
            run(),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_list_knowledge",
            "List known behavior for an origin: issues triaged as bugs or intended behavior, who decided and why, with duplicates and repeat occurrences rolled up. Read this before triaging new findings. No model call.",
            schema(
                json!({"origin":{"type":"string","maxLength":2048},"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":50}}),
                &[],
            ),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_recheck_deployment",
            "After a deploy, verify the deployment at candidate_url against every open issue (untriaged, needs review or bug) found on source_origin (default: the candidate's origin), up to 25. Each issue gets its own fresh-browser verification; intended behavior and duplicates are skipped. Can change data on the candidate site and consume model usage. Reuse the same recheck_id when retrying.",
            schema(
                json!({"recheck_id":id_schema(),"candidate_url":{"type":"string","maxLength":2048},"source_origin":{"type":"string","maxLength":2048},"deployment_ref":{"type":"string","minLength":1,"maxLength":200},"project_id":id_schema(),"task_id":id_schema()}),
                &["recheck_id", "candidate_url"],
            ),
            false,
            true,
            true,
            true,
        ),
        tool(
            "scout_get_recheck",
            "Read a deployment recheck: each issue's verification status and outcome, skipped issues with reasons, and counts of resolved, still_reproducible, blocked, inconclusive and pending checks. complete=true when every check has finished. No model call.",
            schema(json!({"recheck_id":id_schema()}), &["recheck_id"]),
            true,
            false,
            true,
            false,
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
            "scout_list_projects",
            "List the project IDs this user has started jobs in or configured in settings, most recently used first, with each project's label, job and run counts, and the model and limits a new run in it would use (model.source is project or default). A project is any UUID passed as project_id; to start a new one, use a new UUID (scout_new_request_id can allocate one). No model call.",
            schema(json!({}), &[]),
            true,
            false,
            true,
            false,
        ),
        tool(
            "scout_get_project",
            "Read what a new run in one project would use: its model (with model.source project or default), navigation model and resolved limits, plus its job and run counts. Works for a project with no runs yet. No model call.",
            schema(json!({"project_id":id_schema()}), &["project_id"]),
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
            "Queue URL-only exploration. Can interact with and change data on the target site and may incur model usage. job_id is required for safe retries; same UUID and inputs reuse the original admission. No brief required. The model is model if given, else the project's model for project_id (see scout_list_projects / scout_get_project), else the saved default; the job records which in settings.modelSource. app_memory=false runs without earlier-run memory for this app; omitted follows the saved default. continue_from_run_id carries on from a failed, interrupted or cancelled exploration instead of starting again at the entry page.",
            schema(
                json!({"job_id":id_schema(),"project_id":id_schema(),"task_id":id_schema(),"url":{"type":"string","maxLength":2048},"viewport_profile":choice(&["desktop","tablet","mobile"]),"auth_mode":choice(&["auto","sign_in","public"]),"session_id":id_schema(),"auto_reproduce":{"type":"boolean"},"app_memory":{"type":"boolean"},"continue_from_run_id":id_schema(),"model":model()}),
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
            "Queue the existing fresh-browser suspect reproduction. Can change data on the target site and may consume model usage. Stable job_id required; server eligibility/deduplication rules still apply. model optionally runs this reproduction on its own model.",
            schema(
                json!({"job_id":id_schema(),"source_action_id":id_schema(),"model":model()}),
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
