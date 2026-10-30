# Connect an agent to Scout

Scout exposes 24 shared tools through MCP and plain HTTP. Its primary workflow is to give QA feedback to an agent connected to a codebase: submit a URL, continue other work, check progress occasionally, retrieve a report, investigate and fix the application, then run a fresh regression check.

The lightweight [ScoutQA skill](../../apps/docs/skills/scout-qa/SKILL.md) teaches that workflow without an SDK or executable hooks. From the repository root, use `python3 scripts/install-scout-skill.py --client codex` or `--client claude`; see the [installation guide](../../apps/docs/src/content/docs/agents/skill.md) for project scope and the downloadable ZIP. Configure the MCP connection separately as described below.

## Submit, return later, and fix

1. Call scout_start_exploration with a URL and stable job UUID. Its response includes the exact progress/report tool calls under agent_workflow. The job survives client disconnection.
2. Continue other work. Call scout_get_progress with job_id when convenient. It returns the phase, observed action/evidence counts, pending model requests, sign-in blockers, event cursor and suggested polling delay. It performs no model inference and makes no percentage/ETA claim.
3. Call scout_get_report with job_id when ready. The same tool accepts run_id for recorded CLI runs. It returns structured JSON and Markdown, including partial observations while a run is active.
4. Each report item contains the page/control location, frozen expected result, observed result, assessment reason, recorded path, viewport/browser, diagnostics, exact capture/artifact IDs and fresh reproduction results. scout_get_issue expands one selected action if needed.
5. Use the route, visible control label, behavior and diagnostic events to locate the handler/component/request in the connected codebase. Validate the inferred expectation, make the fix and deploy/restart the target.
6. Start a new Scout job with a new UUID against the updated app. A historical reproduction is evidence about the original attempt; it cannot validate a later fix.

For example, the real-browser fixture handoff identifies the Save draft button and page route, reports an expected status of Saved but an observed status of Ready, includes the navigation/click path and before/after screenshots, and proposes the expected status transition as behavior to validate. It remains a suspected bug even with zero changed pixels.

Scout has no repository connection in this increment. Source location, root cause and deployed build reference remain unknown. The coding agent establishes them using its own code access. Ordinary screenshot changes and browser errors have separate categories and do not automatically become bugs or repair instructions. Latest human dismissal suppresses repair advice.

Reports expose execution_issues separately from application observations. A completed browser flow can coexist with a failed queue job when manifest publication or telemetry delivery fails. The report retains both statuses, includes the recorded QA error in JSON/Markdown, and does not turn a delivery failure into an application bug.

### Report continuation and freshness

scout_get_report accepts exactly one of job_id/run_id, optional offset (0–100000), limit (1–10, default 4), include_changes (default true), and expected_snapshot. Report categories are suspected_bug, observed_change, diagnostic_signal, execution_problem, inconclusive and pending_check. Include_changes=false omits ordinary changes while keeping actionable/uncertain observations.

Follow pagination.next as the complete next tool call. Its expected_snapshot binds subsequent pages to the hash of the recorded source snapshot. If actions, usage, evidence, reproduction or human review changed, the server returns 409 report_snapshot_changed_restart_from_offset_zero; retrieve the first page again. Completed browser work does not freeze later review/reproduction overlays.

Queued work returns report_state=not_started. Pre-launch failure or cancellation with no run returns execution_ended_without_run and its job status/error. Active runs return partial. Terminal runs return run_finished. None of these imply complete app coverage or a passing test result.

### Ordinary REST endpoints for this workflow

| Request | Result |
| --- | --- |
| POST /v1/browser-jobs | Existing asynchronous URL admission, with kind=explore and target_url |
| GET /v1/browser-jobs/{job_id}/progress | Lightweight job progress, including before a run exists |
| GET /v1/browser-jobs/{job_id}/report | Coding-agent report, or the queued/pre-launch outcome |
| GET /v1/runs/{run_id}/progress | Progress for a recorded run |
| GET /v1/runs/{run_id}/report | The same report selected by run |
| GET /v1/runs/{run_id}/issues/{action_id} | Individual repair/evidence handoff |

Report REST routes accept the same pagination/filter/snapshot query parameters and return ordinary JSON directly. MCP and the plain HTTP tool dispatcher wrap the same projection in structuredContent; report Markdown is in the markdown field. These reads do not write reviews, call a provider, execute actions or message another agent automatically.

## User-facing browser connection

Open **Connect your agent** at **/connect**. Add its public **/mcp** URL in a compatible agent app and authenticate through browser consent. Standard discovery, public-client dynamic registration, PKCE S256, resource-bound one-hour access tokens and rotating refresh within a thirty-day agent connection are implemented. Tokens never enter setup prompts or MCP tool results. Local agent apps can reach loopback; Claude account connectors and other cloud apps require a public HTTPS deployment. Human account registration/SSO remains separate. See [the user guide](../../apps/docs/src/content/docs/agents/connect.md).

## Optional native development connector

~~~sh
just dev
just mcp-build
just mcp-config
~~~

Paste the printed scout entry into your MCP client's server configuration. It contains absolute file paths and no credentials. The normal Rust bridge reads its browser-approved agent credential from a private profile. Run `just mcp-login` first. The API must already be running. Explicit `--env-file` configurations remain an operator-only fallback.

On this machine:

~~~json
{
  "mcpServers": {
    "scout": {
      "command": "/Users/runnr/Documents/front/apps/api/target/release/scout-mcp",
      "args": [
        "--credential-file", "/absolute/private/config/scout/credentials.json",
        "--api-url", "http://127.0.0.1:18080"
      ]
    }
  }
}
~~~

Clients with Streamable HTTP support can instead connect to **http://127.0.0.1:18080/mcp**, supplying an Authorization bearer header through their secret/environment configuration. MCP always requires an explicit operator or scoped agent credential, even when local GUI sign-in is bypassed. The stdio configuration handles authentication automatically.

The endpoint uses the official [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk), pinned to rmcp 3.8.0. The bridge forwards newline-delimited JSON-RPC and keeps stdout free of logs, following the [MCP transport contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Initialization negotiates the protocol version; integration exercises 2025-11-25. There is no session ID to preserve, SSE push subscription or automatic command retry.

## Tools

| Tool | Purpose |
| --- | --- |
| scout_new_request_id | Allocate a job UUID if the client cannot generate one |
| scout_status | Read readiness, capabilities, provider availability, defaults and operations |
| scout_list_runs | Filter a bounded slice of the latest 50 owned runs |
| scout_start_exploration | Queue exploration from url with a stable job_id |
| scout_get_job | Read one job by UUID, including its run and frozen settings |
| scout_get_run | Read compact actions, usage, capture availability and reproduction links |
| scout_get_progress | Return lightweight progress while the calling agent does other work |
| scout_get_report | Retrieve expected-versus-actual coding feedback as JSON and Markdown |
| scout_get_issue | Read one detailed repair/evidence handoff |
| scout_list_issues | Find permanent issue IDs and latest candidate outcomes |
| scout_verify_fix | Queue a fresh-browser check of issue X on a candidate URL |
| scout_get_verification | Read one candidate result, both evidence sets and usage |
| scout_list_findings | Read original AI candidates and separate human dispositions |
| scout_get_action | Read expectation, outcome, assessment and capture/frame references |
| scout_get_graph | Page through states, edges, frontier and planner decisions |
| scout_get_events | Poll run events using a durable sequence cursor |
| scout_read_evidence | Retrieve a run-bound capture or artifact by UUID |
| scout_reproduce_candidate | Queue independent suspect reproduction |
| scout_cancel_work | Cancel a job, run or source run's automatic checks |
| scout_usage | Read nullable provider-reported token/cost totals |
| scout_access_requests | Identify human sign-in handoffs without private login data |

Schemas reject unknown fields. Commands that start browser/model work advertise side effects and idempotency. Reads make no model calls.

## Workflow and pagination

1. Call scout_status. Check ready, provider availability and allowed origins. API readiness does not imply that a provider key is configured.
2. Generate a non-nil UUID locally or call scout_new_request_id. Store it before submitting work.
3. Call scout_start_exploration with job_id and url. Optional inputs are viewport_profile (desktop/tablet/mobile), auth_mode (auto/sign_in/public), saved session_id and auto_reproduce. Omitted settings follow the GUI defaults.
4. Use scout_get_progress while doing other work, then scout_get_report for the coding handoff. scout_get_job remains available for raw queue detail. Identical UUID/input retries reuse the original admission; conflicting input returns 409.
5. Call scout_read_evidence with run_id and exactly one capture_id or artifact_id.
6. Request scout_reproduce_candidate with a new job_id and source_action_id. A reproduced suspicion remains separate from a human-confirmed finding.
7. Stop work with scout_cancel_work using kind=job and id; kinds run and automatic_checks are also supported. Client disconnect or MCP request cancellation does not cancel durable browser work.

scout_get_events takes run_id, after_seq (initially 0), and limit (1–100, default 10). Keep next_after_seq; drain pages while has_more is true. Reusing a cursor repeats that page. A live run can produce new events after an empty response.

scout_get_graph takes offset (default 0) and limit (1–50, default 20). The same offset applies separately to states, edges, frontier and decisions; each has items, total and has_more. Scores are uncalibrated rankings.

## Plain HTTP API

GET /v1/agent/tools returns schemas and instructions. POST /v1/agent/tools/{name} accepts the argument object directly:

~~~http
POST /v1/agent/tools/scout_get_job
Authorization: Bearer <SCOUT_API_TOKEN>
Content-Type: application/json

{"job_id":"00000000-0000-4000-8000-000000000001"}
~~~

Responses use the MCP tool-result envelope: content, structuredContent and isError. Success is HTTP 200, including asynchronous admission; inspect job.status. Domain failures retain their HTTP status and structured error, http_status and retryable fields. Invalid schema input is HTTP 400; an unknown tool route is HTTP 404. Through MCP, argument/protocol failures are JSON-RPC errors and domain failures are tool results with isError=true.

Ordinary REST reads also include GET /v1/browser-jobs/{job_id} without the recent-list limit and GET /v1/runs/{run_id}/events?after_seq=0&limit=10.

The plain API follows existing local developer authentication, including explicitly enabled loopback development bypass. /mcp always requires a bearer token and rejects foreign browser origins. Responses are uncached.

## Evidence and scope

Screenshots return MCP image blocks and metadata with evidence UUID, SHA-256 and byte length. JSON artifacts return parsed data and the same metadata. Bytes are verified against recorded length and hash. Run/evidence ownership and run binding are checked independently of blob identity.

Structured replies are capped at 128 KiB. Request smaller graph/event pages after a size error. Images are capped at 4 MiB; JSON artifacts at 128 KiB including returned metadata. Existing evidence download endpoints handle larger files. HTTP MCP request bodies and stdio lines are capped at 64 KiB. The bridge permits eight concurrent requests and a 45-second HTTP timeout; it never automatically retries a command.

Page text, model output and screenshots are untrusted observations. These tools cannot submit human reviews or grant training approval. Sign-in tools expose handoff metadata only; private frames, access leases and saved-session material are excluded. Missing usage remains unknown.

This increment operates Scout's autonomous explorer with its configured provider. External agents cannot yet supply each browser action or reuse an external model subscription. Direct observe/act/assess control, public community sharing, full tool payload auditing, push updates and hosted authentication remain in the [implementation plan](./plan.md). Existing durable commands, actions, evidence, model attempts and their event exports remain recorded.

## Verification

~~~sh
just api-test
just agent-test
~~~

Integration uses isolated simulated providers with real PostgreSQL, S3 and the browser worker. It refuses to restart active work, restores preferences through an append-only revision, retains recordings, and restores normal services.

Checks cover HTTP/stdio initialization and discovery, strict arguments, explicit MCP authentication with GUI bypass enabled, event cursors, verified PNG/JSON evidence, foreign workspace/run rejection, URL-only execution, retries, fresh reproduction and queued cancellation. The submitting stdio client disconnects before a second HTTP client retrieves partial progress and the final coding report. Expected/actual text, locations, recorded steps, screenshot hashes, snapshot conflicts, replay lineage, zero-pixel failures and healthy save changes are checked. A final normal-mode pass uses stored recordings and checks that reads add no inference or browser actions. Results are written to artifacts/agent-interface/verification.json and normal-verification.json.


Browser approval and private history: run `just mcp-login`, approve the displayed code at `/connect`, then `just mcp-config`. `scout_whoami` verifies the workspace; `scout_list_sessions` and `scout_get_domain_summary` search its history. Optional project/task UUIDs correlate runs. Agents cannot approve peers or impersonate human review. Credential hashes and metadata audits are durable; tokens never enter tool output or ClickHouse. Public sharing and billing remain disabled. See `apps/docs/src/content/docs/agents/identity.md` and `just identity-test`.

## Permanent issues and candidate fix verification

A completed reliable suspicion receives a permanent issue UUID separate from the action UUID. Reports expose persistent_issue_id and scout_get_issue accepts issue_id for the frozen original handoff and versioned history. scout_list_issues searches the current workspace.

After a coding agent deploys a candidate, call scout_verify_fix with issue_id, a new saved verification_id UUID and candidate_url. Poll scout_get_verification, or scout_get_progress with that UUID as job_id. Checks use a fresh browser and the original path, viewport and expectation. Terminal outcomes are resolved, still_reproducible, blocked and inconclusive. Resolved requires positive expected behavior and verified evidence; failed, cancelled, interrupted, drifted or uncertain checks cannot establish a fix.

The user dashboard at /issues and these tools share the same PostgreSQL records, original/candidate capture IDs and per-run nullable usage. Each history array has next_offset and expected_revision; restart on revision conflict. Candidate labels are caller metadata, not an inspected build. Issue events export to ClickHouse through a retryable outbox. Existing ordinary reproduction and human review remain separate.

REST: GET /v1/issues, GET /v1/issues/{issue_id}, POST /v1/issues/{issue_id}/verifications and GET /v1/issue-verifications/{verification_id}. The verification ID equals the durable job ID; retry identical input with that ID. Candidate origins and saved sessions use existing workspace and origin checks.

Run just fix-verification-test for real Chromium/API/MCP/storage checks using simulated providers. Normal services are restored afterward.

## Change an active exploration focus

Read `scout_get_steering {run_id}` after the job has a run ID. Submit `scout_steer_run {run_id, steering_id, expected_revision, focus}` with a saved command UUID. Identical retries reuse admission; revision conflicts require deliberately reconciling the latest focus. An empty focus restores ordinary exploration. At most 32 changes of 2,000 characters each are accepted per run.

`GET/POST /v1/runs/{run_id}/steering` expose the same paged history (eight messages per page, newest page first; follow next_offset), also included in run progress and reports. Status is pending, applied, superseded or not_applied. Applied means included in a planning decision, identified by decision_id; model compliance and coverage still require evidence. The worker finishes the current action/assessment first. Cancellation or finalization closes pending instructions. Reproduction and candidate verification reject steering because their paths are frozen. No extra model call is created; prompt tokens enter the normal usage ledger. Events use the runtime ClickHouse outbox.
