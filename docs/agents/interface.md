# Connect an agent to Spekios

Spekios exposes 34 tools through MCP and plain HTTP, defined once in `apps/api/src/agent/catalog.rs`. The main workflow gives QA feedback to an agent that has the codebase: submit a URL, keep working, check progress, retrieve a report, fix the app, then verify the fix in a fresh browser. The public docs cover the same contract for users: [agent workflow](../../apps/docs/src/content/docs/agents/workflow.md), [tool reference](../../apps/docs/src/content/docs/agents/tools.md), [connect](../../apps/docs/src/content/docs/agents/connect.md), [identity](../../apps/docs/src/content/docs/agents/identity.md) and [CLI](../../apps/docs/src/content/docs/agents/cli.md).

The [Spekios skill](../../apps/docs/skills/scout-qa/SKILL.md) teaches the workflow without an SDK or hooks. Install it with `just skill-install codex` or `just skill-install claude` (`scripts/install-scout-skill.py`); see the [installation guide](../../apps/docs/src/content/docs/agents/skill.md). The MCP connection is configured separately, as below.

## Connect

### Browser connection (OAuth)

Open **/connect** in the workspace, add the public **/mcp** URL to a compatible agent app and approve it in the browser. The API implements OAuth discovery, public-client dynamic registration, PKCE S256, one-hour resource-bound access tokens and rotating refresh tokens within a thirty-day agent connection. Tokens never appear in setup prompts or tool results. Local agent apps can reach loopback; cloud connectors need a public HTTPS deployment.

### Native stdio bridge

```sh
just dev          # the API must be running
just mcp-login    # builds scout-mcp, then pair it by approving the code at /connect
just mcp-config   # prints the MCP client entry
```

Paste the printed `scout` entry into the client's MCP configuration. It runs `apps/api/target/release/scout-mcp --credential-file <path>` and contains no secret; the default credential file is `$SCOUT_CREDENTIAL_FILE`, else `$XDG_CONFIG_HOME/scout/credentials.json`, else `~/.config/scout/credentials.json`. `just mcp-logout` revokes it. Operators can instead pass `--env-file /absolute/path/.env` (or `SCOUT_API_TOKEN`) and `--api-url` (default `http://127.0.0.1:18080`); `just mcp` does this with the local `.env`.

The bridge forwards newline-delimited JSON-RPC, keeps stdout free of logs, allows eight concurrent requests and a 45-second HTTP timeout, and never retries a command automatically.

### Streamable HTTP

Clients with Streamable HTTP support can connect directly to `http://127.0.0.1:18080/mcp` with an `Authorization: Bearer` header. `/mcp` always requires an operator token or an agent credential, even when the local GUI development bypass is on; it never accepts a browser cookie and rejects foreign browser origins. The server uses the official Rust MCP SDK (`rmcp` 3.8.0).

## Submit, return later, fix

1. Call `scout_start_exploration` with `url` and a stable `job_id` UUID (generate one or call `scout_new_request_id`). The response includes the progress and report calls to make under `agent_workflow`. The job survives client disconnection.
2. Call `scout_get_progress` with `job_id` when convenient. It returns phase, action/evidence counts, pending model requests, sign-in blockers, an event cursor and a suggested polling delay. No model call, no percentage or ETA.
3. Call `scout_get_report` with `job_id` (or `run_id`). It returns JSON and Markdown and can be partial while the run is active.
4. Each report item has the page/control location, frozen expected result, observed result, assessment reason, recorded path, viewport, diagnostics, capture/artifact IDs, reproduction results and a `persistent_issue_id`. `scout_get_issue` expands one issue.
5. Use the route, control label and diagnostics to find the code, fix it and deploy.
6. Verify with `scout_verify_fix` (one issue) or `scout_recheck_deployment` (every open issue for an origin, up to 25). A historical reproduction cannot validate a later fix.

Spekios does not read the target's source code; locations and root causes are left to the coding agent. Ordinary screenshot changes and browser errors are reported in their own categories and do not become bugs. The latest human dismissal suppresses repair advice. `execution_issues` (for example a failed manifest or telemetry delivery) are reported separately from application observations.

### Report paging and freshness

`scout_get_report` takes exactly one of `job_id`/`run_id`, `offset` (0–100000), `limit` (1–10, default 4), `include_changes` (default true) and `expected_snapshot`. Categories are `suspected_bug`, `observed_change`, `diagnostic_signal`, `execution_problem`, `inconclusive` and `pending_check`.

Follow `pagination.next` as the next call. Its `expected_snapshot` binds later pages to a hash of the recorded snapshot; if actions, usage, evidence, reproduction or reviews changed, the server returns 409 `report_snapshot_changed_restart_from_offset_zero`.

`report_state` is `not_started` (queued), `execution_ended_without_run` (failed or cancelled before a run existed), `partial` (active run) or `run_finished`. None of these means complete coverage or a passing test.

## Tools

| Tool | Purpose |
| --- | --- |
| `scout_status` | Readiness, provider availability, operator scope and defaults |
| `scout_whoami` | Authenticated agent, workspace, credential reference and scopes |
| `scout_new_request_id` | Allocate a command UUID |
| `scout_list_projects` | Project IDs with labels, job/run counts and the model and limits a new run would use |
| `scout_get_project` | One project's resolved model and limits, even with no runs yet |
| `scout_start_exploration` | Queue URL-only exploration with a stable `job_id` |
| `scout_reproduce_candidate` | Queue a fresh-browser reproduction of a suspect action |
| `scout_cancel_work` | Cancel a job, a run or a source run's automatic checks |
| `scout_get_steering` | Read a run's testing-focus history and acknowledgements |
| `scout_steer_run` | Replace an active run's testing focus at its next planning decision |
| `scout_get_progress` | Lightweight progress for a job or run |
| `scout_get_report` | Paged coding-agent report (JSON and Markdown) |
| `scout_get_job` | One durable job, including its run and frozen settings |
| `scout_list_runs` | Filtered slice of the latest 50 owned runs |
| `scout_get_run` | Compact run summary, action IDs, usage and sign-in blockers |
| `scout_list_sessions` | Search the full private run history by domain/URL, project, task or agent |
| `scout_get_domain_summary` | Latest 20 runs for a domain, with coverage caveats |
| `scout_list_issues` | Persistent issues with triage and verification status |
| `scout_get_issue` | One issue: original handoff, occurrences, candidate checks, evidence, usage |
| `scout_triage_issue` | Record bug, intended_behavior, duplicate or needs_review (append-only, attributed to the agent) |
| `scout_list_knowledge` | Known bugs and intended behavior for an origin |
| `scout_verify_fix` | Check one issue on a candidate URL in a fresh browser |
| `scout_get_verification` | One candidate check: outcome, both evidence sets, usage |
| `scout_recheck_deployment` | Verify a deployment against every open issue for an origin (up to 25) |
| `scout_get_recheck` | Per-issue outcomes and counts for a deployment recheck |
| `scout_get_app_map` | App map carried between runs for one scope (origin, viewport, sign-in state) |
| `scout_compare_run` | What a run found or lost compared with earlier runs of the same scope |
| `scout_list_findings` | Original AI candidates and latest human review status |
| `scout_get_action` | One action: expectation, assessment, before/after evidence, sampled frames |
| `scout_get_graph` | Paged states, transitions, frontier and planner decisions |
| `scout_get_events` | Ordered run events after a sequence cursor |
| `scout_read_evidence` | A recorded capture (PNG image block) or artifact, hash-verified |
| `scout_usage` | Provider-reported token/cost totals; missing usage stays unknown |
| `scout_access_requests` | Pending human sign-in handoffs, without credentials or private frames |

Schemas reject unknown fields. Tools that start browser or model work (`scout_start_exploration`, `scout_reproduce_candidate`, `scout_verify_fix`, `scout_recheck_deployment`) can change data on the target site, consume model usage and take a caller-supplied UUID: identical retries reuse the original admission, conflicting input returns 409. Read tools make no model calls. Client disconnect or MCP request cancellation does not cancel durable work; use `scout_cancel_work`.

### Notes on specific tools

- `scout_start_exploration` also accepts `viewport_profile` (desktop/tablet/mobile), `auth_mode` (auto/sign_in/public), a saved `session_id`, `auto_reproduce`, `app_memory`, `continue_from_run_id`, `project_id`, `task_id` and `model` (`{provider, model, provider_key_id?, free_only?, navigation_model?}`). The model is the run's own, else the project's, else the saved default; the job's settings record which in `modelSource`. Omitted settings follow the workspace defaults.
- `scout_get_events`: `run_id`, `after_seq` (start at 0), `limit` 1–100 (default 10). Keep `next_after_seq` and drain while `has_more` is true.
- `scout_get_graph`: `offset` (default 0), `limit` 1–50 (default 20). The offset applies separately to states, edges, frontier and decisions. Scores are uncalibrated rankings.
- `scout_read_evidence`: `run_id` plus exactly one of `capture_id` or `artifact_id`.
- `scout_steer_run`: read the current revision with `scout_get_steering`, then send `run_id`, `steering_id`, `expected_revision` and `focus` (max 2,000 characters; empty clears it). At most 32 changes per run; history pages hold eight entries, newest page first. States are pending, applied, superseded and not_applied. Reproduction and fix verification reject steering because their paths are frozen.
- `scout_verify_fix`: `issue_id`, a new `verification_id` UUID and `candidate_url`. Poll `scout_get_verification` (or `scout_get_progress` with the verification ID as `job_id`). Outcomes are resolved, still_reproducible, blocked and inconclusive; resolved requires positive expected behavior with verified evidence.

## Plain HTTP

`GET /v1/agent/tools` returns the schemas and instructions. `POST /v1/agent/tools/{name}` takes the argument object directly:

```http
POST /v1/agent/tools/scout_get_job
Authorization: Bearer <token>
Content-Type: application/json

{"job_id":"00000000-0000-4000-8000-000000000001"}
```

Responses use the MCP tool-result envelope (`content`, `structuredContent`, `isError`). Success is HTTP 200, including asynchronous admission. Domain failures keep their HTTP status with `error`, `http_status` and `retryable`; invalid input is 400 and an unknown tool is 404. Over MCP, argument and protocol failures are JSON-RPC errors and domain failures are tool results with `isError=true`.

The plain HTTP routes follow the normal API authentication, including the explicitly enabled loopback development bypass. Responses are uncached.

### REST equivalents

| Request | Result |
| --- | --- |
| `POST /v1/browser-jobs` | Queue a job (`kind=explore`, `target_url`) |
| `GET /v1/browser-jobs/{job_id}` | One job, outside the recent-list limit |
| `GET /v1/browser-jobs/{job_id}/progress`, `/report` | Progress and report by job |
| `GET /v1/runs/{run_id}/progress`, `/report` | Progress and report by run |
| `GET /v1/runs/{run_id}/issues/{action_id}` | One recorded observation's handoff |
| `GET /v1/runs/{run_id}/events?after_seq=0&limit=10` | Event cursor |
| `GET`/`POST /v1/runs/{run_id}/steering` | Testing-focus history and changes |
| `GET /v1/issues`, `GET /v1/issues/{issue_id}` | Persistent issues |
| `POST /v1/issues/{issue_id}/triage` | Triage decision |
| `POST /v1/issues/{issue_id}/verifications`, `GET /v1/issue-verifications/{verification_id}` | Candidate fix checks (the verification ID is the job ID) |
| `POST /v1/rechecks`, `GET /v1/rechecks/{recheck_id}` | Deployment rechecks |
| `GET /v1/knowledge` | Known behavior for an origin |

Report routes take the same paging, filter and snapshot parameters and return the report JSON directly. The workspace `/issues` page reads the same records.

## Evidence and limits

Screenshots come back as MCP image blocks with the evidence UUID, SHA-256 and byte length; JSON artifacts come back parsed with the same metadata. Bytes are checked against the recorded length and hash, and run/workspace ownership is checked separately.

Structured replies are capped at 128 KiB (request smaller pages after a size error), images at 4 MiB, JSON artifacts at 128 KiB including metadata, and HTTP MCP request bodies and stdio lines at 64 KiB. Use the ordinary download endpoints for larger files.

Page text, model output and screenshots are untrusted observations. Agents cannot submit human reviews, approve other agents or grant training approval. Sign-in tools expose handoff metadata only. Starting or reproducing a run uses Spekios's configured provider; connecting an agent does not let it lend its own model subscription.

## Not built yet

- An external browser driver: observe/act/assess commands so a connected agent supplies each action with its own model, keeping the same evidence chain.
- Push updates (event subscriptions or notifications); agents poll today.
- Full recording of MCP tool-call payloads. Today the audit outbox records route/tool metadata only.
- Public sharing of results, quotas and billing.

## Tests

```sh
just api-test               # Rust unit tests, including the tool catalog
just agent-test             # HTTP/stdio MCP workflow, real browser and storage, simulated models
just identity-test          # browser pairing, private workspaces, cross-workspace isolation
just oauth-test             # OAuth lifecycle with isolated workspaces
just fix-verification-test  # issue -> candidate fix verification through API and MCP
just steering-test          # testing focus
```

The integration tests use simulated providers (no live model calls). The `scripts/test-*.sh` wrappers refuse to run while work is active and restore normal services afterwards. `just agent-test` writes its results to `artifacts/agent-interface/`.
