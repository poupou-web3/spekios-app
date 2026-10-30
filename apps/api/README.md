# Rust API

Rust 2024 with Axum/Tokio. Serves the [user workspace and operations console](../../docs/platform/workspace.md), reads recorder data, accepts browser jobs and runs a durable OpenAI/Claude/OpenRouter gateway. Browser automation remains a separate TypeScript/Playwright worker. The interface uses embedded HTML/CSS/JavaScript; it adds no Node API or web server. See the [gateway guide](../../docs/platform/model-gateway.md) for setup, evidence storage, usage and recovery.

Start it with the rest of the stack using `just dev` or `bash scripts/start-local.sh` from the repository root. The host address is **http://127.0.0.1:18080**. The container runs as a non-root user with a read-only filesystem, a 256 MiB memory cap and one CPU. Its image build runs the Rust tests and produces a release binary.

| Endpoint | Behavior |
| --- | --- |
| `GET /`, `/connect`, `/issues`, `/assets/app/{path}`, `/assets/ui/{path}` | Public embedded customer workspace (`apps/web/src`) and shared kit (`packages/web-ui/src`), listed at build time by `build.rs`; no credentials or private run data; same CSP, MIME, no-store and nosniff policy. The operator back office is a separate deployment and is not served here |
| `GET /healthz` | Process liveness; public on local loopback |
| `GET /v1/auth-mode` | Public uncached access-mode discovery; returns only `local_development` or `bearer_token` |
| `GET /readyz` | Verifies database schema and gateway recovery/readiness |
| `POST /mcp` | MCP tools through Streamable HTTP; explicit bearer required even with GUI development bypass |
| `GET /v1/agent/tools` | Discover 18 strict agent tool schemas |
| `POST /v1/agent/tools/{name}` | Invoke the same tools through plain HTTP |
| `GET /v1/capabilities` | Gateway configuration, workspace availability, bounded exploration/reproduction entry points |
| `GET /v1/runs` | Latest 50 owned runs with action counts and current human-review summaries |
| `GET /v1/runs/{run_id}` | Consistent snapshot of run, actions, captures, artifacts, events, graph, reproduction links/results, model requests and usage |
| `GET /v1/runs/{run_id}/graph` | Exact page states, action edges, frontier and model decisions; 404 for non-explorer runs |
| `GET /v1/runs/{run_id}/progress` | Lightweight phase, action/evidence counts, blockers and event cursor |
| `GET /v1/runs/{run_id}/report` | Snapshot-bound JSON/Markdown coding-agent report; offset, limit, include_changes and expected_snapshot |
| `GET /v1/runs/{run_id}/issues/{action_id}` | Repair handoff with expected/actual, path, diagnostics and evidence retrieval references |
| `GET /v1/runs/{run_id}/events` | Durable event page with after_seq, limit, next_after_seq and has_more |
| `GET /v1/captures/{capture_id}` | Capture metadata and bucket references |
| `GET /v1/captures/{capture_id}/image` | Authenticated PNG retrieval with size and SHA-256 verification |
| `GET /v1/artifacts/{artifact_id}/content` | Authenticated mask, delta or manifest retrieval with hash verification |
| `GET /v1/operations` | Consistent snapshot of run counts, evidence backlog and event-export acknowledgements |
| `GET /v1/browser-jobs` | Latest 50 jobs, worker heartbeats and saved exploration defaults |
| `GET /v1/browser-jobs/{job_id}/progress` | Nonblocking progress, including queued/pre-launch state |
| `GET /v1/browser-jobs/{job_id}/report` | Coding report selected by job, including explicit no-run outcomes |
| `GET /v1/browser-jobs/{job_id}` | One owned job directly by UUID, outside the recent-list limit |
| `POST /v1/browser-jobs` | Idempotent URL exploration or suspect-reproduction admission; execution is asynchronous |
| `GET /v1/exploration-settings` | Current revision and effective nonsecret exploration preferences, with operator scope retained |
| `POST /v1/exploration-settings` | Append a validated preferences revision using optimistic concurrency and an idempotent request UUID |
| `POST /v1/browser-jobs/{job_id}/cancel` | Idempotent queued/running job cancellation; pending work returns 202 |
| `POST /v1/runs/{run_id}/cancel` | Durable cancellation of an active explorer/reproduction; retains evidence and usage |
| `POST /v1/runs/{run_id}/automatic-reproductions/cancel` | Stops pending and admitted automatic children, including after the source finishes; preserves unrelated manual work |
| `POST /v1/actions/{action_id}/reviews` | Append a human finding decision with evidence verification, optimistic revision and idempotent UUID |
| `GET /v1/model-providers` | Configured providers and authentication modes; no keys |
| `POST /v1/model-requests` | Durable idempotent inference admission |
| `GET /v1/model-requests/{request_id}` | Attempts, output, usage and evidence references |
| `GET /v1/usage` | Per-user token/cost totals, separated by fixture/live mode |

Data routes require `Authorization: Bearer <SCOUT_API_TOKEN>`. Setup generates this token in the ignored `.env`, preserving existing storage credentials. Use `just runs` or `just run RUN_UUID` to read data without putting the token in shell history. Responses use `Cache-Control: no-store`. Inputs use typed UUIDs and parameterized SQL, and queries enforce the authenticated workspace. `just mcp-login` issues per-agent credentials through browser approval; `/connect` manages revocation. The shared local operator token remains privileged infrastructure access.

For local GUI development, explicitly enabling `SCOUT_DEV_AUTH_BYPASS=true` also admits tokenless requests on literal `localhost`, `127.0.0.1` or `[::1]` hosts with a valid port. Browser Origin must match the request's origin, and cross-site/same-site fetch metadata is rejected; forwarded headers do not broaden access. Bad or duplicated Authorization headers remain rejected. Valid bearer access for container workers still works. The flag defaults to false, Compose publishes the API only on loopback, and the provider-fixture overlay disables bypass for normal authentication tests.

The run-list `summary` contains `actions`, `candidates`, `pending_findings`, `confirmed_findings` and `dismissed_findings`. Finding totals use each action's latest scoped human-review revision in the same database snapshot; reproduction runs do not duplicate their source candidate counts. Run detail also exposes a bounded `model_calls` projection for actual attempt identities, state, nullable reported usage and cost. Full provider payloads and responses remain in their separate authenticated model-request details and bucket evidence. These fields power the user dashboard and back office; `just web-contract-test` checks them against recorded runs.

The token represents one local developer, not multi-user login. Reports use a read-only connection with five-second timeouts. A serialized writer handles model admission, settlement and outboxes with a PostgreSQL advisory lock. Browser-job admission uses its own serialized writer and transaction lock. A writable volume holds response journals. Connection loss exits the process so Compose can restart and recover it. Private native app login is supported; external identity-provider handoff and subscription authentication remain unfinished. Provider API keys come from private environment variables.

Browser jobs accept `{ "job_id": "UUID", "kind": "explore", "target_url": "http://exploration-fixture:8082/branches" }` or `{ "job_id": "UUID", "kind": "reproduce", "source_action_id": "UUID" }`. A new job returns 202; identical retries return 200 and `reused: true`; a reused ID with different inputs returns 409. Unknown fields and credential-bearing URLs are rejected. Public https origins are accepted; private, HTTP and internal origins must be listed in `SCOUT_ALLOWED_ORIGINS`. Admission requires a configured model and permits at most ten queued/running jobs. The worker intersects saved origins with its current configuration before execution.

Exploration also accepts optional `viewport_profile`: `desktop`, `tablet` or `mobile`. Admission snapshots the selected profile or current saved default in the job settings. Before any preferences are saved, `SCOUT_EXPLORER_VIEWPORT` supplies the default (`desktop` otherwise). Reproduction rejects an override and uses its source run's profile. Graph schema version 2 adds state/frontier planning metadata and action-linked ranked selections. The same selections and replanning events are retained in manifests and exported to ClickHouse; see [the planner](../../docs/exploration/planner.md).

An exploration request can also include `"auto_reproduce": true`. Omission follows the effective saved default, initially false. Admission freezes the current saved case/action limits. Before preferences are saved, `SCOUT_AUTO_REPRODUCE_MAX_CASES` defaults to 2, bounded to 1–3; `SCOUT_AUTO_REPRODUCE_MAX_ACTIONS` defaults to 12 total additional replay actions, bounded to 1–24; `SCOUT_AUTO_REPRODUCE` supplies the opt-in default. Browser-job callers cannot supply per-job limit overrides, and reproduction requests cannot enable automatic descendants. Manual reproduction admission reuses an existing queued/running check of the same source action, even when its job was generated automatically.

## Agent interface

The Rust API exposes 24 shared MCP/HTTP tools for durable exploration, job polling, findings, actions, graphs, cursor events, verified evidence, reproduction, cancellation, usage and human access blockers. The native scout-mcp binary bridges local MCP stdio clients to /mcp. Users can connect through **/connect** and standard HTTP MCP browser authorization without installing the bridge. Developers can keep the optional native connector with browser-approved private credentials; explicit operator env-file configurations remain compatible. Read the [agent guide](../../docs/agents/interface.md) for schemas, workflow, size bounds, authentication and remaining steering/direct-driver work.

## Exploration settings

`GET /v1/exploration-settings` returns `{ "revision": 0, "settings": { ... } }` before the first saved preference, then the latest scoped revision. `settings` overlays the saved editable fields onto current operator defaults and includes `settingsRevision`; allowed origins remain authoritative server configuration. `GET /v1/browser-jobs` exposes this effective object as `settings` and its revision as `settings_revision`. Capabilities report the effective revision and automatic-check bounds.

`POST /v1/exploration-settings` requires the full typed preference object:

```json
{
  "request_id": "00000000-0000-4000-8000-000000000001",
  "expected_revision": 0,
  "provider": "openrouter",
  "model": "openrouter/free",
  "max_actions": 6,
  "viewport_profile": "desktop",
  "free_only": true,
  "auto_reproduce": false,
  "max_auto_reproductions": 2,
  "max_auto_replay_actions": 12
}
```

Use a fresh non-nil UUID for a new save and the current revision from GET. Providers are `openai`, `anthropic`, `openrouter` and `meta`. Model IDs are trimmed, nonempty, at most 200 characters, contain no control characters and use only ASCII letters, numbers, `/ : . _ -`. Exploration actions are bounded to 1–12, automatic cases to 1–3, and total additional replay actions to 1–24. Viewports are `desktop`, `tablet` and `mobile`. Booleans must be actual JSON booleans. OpenRouter free-only requires `openrouter/free` or a model ending in `:free`; direct-provider free-only flags normalize to false. Saving does not call a model, test a provider connection or require a configured key.

A new revision returns 201 with `{ "revision": N, "settings": { ... }, "reused": false }`. An identical retry uses the same UUID, expected revision and normalized values and returns 200 with `reused: true`. The receipt remains valid after newer revisions exist and describes its originally saved revision; GET retrieves the latest state. A new write against a stale revision returns 409 `revision_conflict`; reusing a request UUID for different normalized content or scope returns 409 `settings_request_id_conflict`. Malformed/unknown fields return 400; unavailable queue/database storage returns 503.

Migration `013-exploration-settings.sql` creates append-only per-workspace/user revision history with a mutation-rejection trigger. Preference writes and new job admission share a PostgreSQL transaction advisory lock. Each newly admitted job freezes effective settings and `settingsRevision`; an existing job UUID retry reconstructs its request against that original snapshot before current defaults or provider readiness can affect it. Saving defaults never updates queued/running job rows. Environment defaults are used until a saved revision exists, and direct recorder CLI commands retain their environment-based configuration.

Only provider/model choice, action limits, viewport, OpenRouter free-only and automatic-check preferences are editable here. Provider API keys, access tokens, origin allowlists, execution mode and network policy cannot be changed through this API. Unknown secret/security fields are rejected. The same normal bearer access or explicitly enabled fenced local-development access applies to these routes; this is the local developer's settings, not a team administration permission system. The [back-office form](../../docs/platform/workspace.md#save-exploration-defaults) preserves dirty drafts and offers explicit conflict/retry handling.

The workspace's **Compare** view retrieves separate authenticated before/after capture images, preserving their UUIDs and independent full-resolution inspection. It uses the existing capture/artifact routes and adds no image mutation or semantic bug-confirmation API.

## Portable report export

The workspace's **Export report** drawer pins its loaded run snapshot and offers Markdown, an evidence ZIP or the existing full JSON projection. The browser loads the two public embedded report modules above and reads evidence through the existing authenticated capture/artifact endpoints. This feature adds no export API endpoint, database table/write, model call or S3 export object. Exports are downloaded locally; no off-machine upload is performed. The CLI equivalent is `just export-report RUN_UUID`, which writes under `artifacts/run-reports/<export_uuid>/` and uses the local token from the ignored `.env` without including it in the archive or console output.

The ZIP includes `report.md`, `report.json`, `manifest.json` and eligible selected-run PNG/JSON artifacts. The client validates UUID/run/reference bindings and verifies streamed file lengths, SHA-256, media types and PNG/JSON formats. Archive paths use validated UUIDs. Invalid, missing, pending, oversized or failed-verification evidence stays in the manifest as a gap. Settling-frame occurrences retain separate IDs even when they share one downloaded artifact. Related source/replay runs are referenced by ID and exported separately. Standalone Markdown has no image links; bundled Markdown links only to included relative image paths. The raw JSON keeps the existing authenticated source projection and does not fetch separate raw model payloads or saved private sessions.

Evidence ZIP limits are 256 evidence entries, 8 MiB per evidence file or bundled document, 64 MiB per archive and two minutes for evidence export, with aggregate admission and final-size checks. Standalone Markdown/JSON do not fetch evidence or use those ZIP limits. Cancellation, navigation and disconnect prevent late GUI downloads. Active snapshots remain partial, and `all_listed_files_verified` describes only the listed files' integrity. The manifest preserves training status and sets `training_approval: false`; a human confirmation is not dataset approval. See [portable run reports](../../docs/runtime/reports.md) for manifest outcomes and scope.

## Reproduction and verification

Run reports expose `automatic_reproductions` as a live overlay containing stable task/source IDs, reserved action count, pending/skipped reasons, child job and fresh reproduction result. A child report also exposes its source lineage. The batch-stop endpoint takes `{}` and returns `cancellation_id`, `run_id`, `status` and `reused`; pending acknowledgement returns 202, completed acknowledgement 200. Unknown/foreign runs return 404, runs without the opt-in return 409. Source stop markers and every existing active-child job/run stop intent commit atomically; repeated calls reuse the batch UUID. Details and test commands are in [automatic reproduction](../../docs/exploration/automatic-reproduction.md).

Capabilities also advertise the supported `navigate`, `click`, `fill`, `select`, `set_checked`, `scroll` and `submit` commands. The Rust API serves their stored JSON evidence; the browser worker validates and dispatches them through the [typed interaction contract](../../docs/exploration/interactions.md).

```sh
cargo test --locked --manifest-path apps/api/Cargo.toml
node scripts/verify-api.mjs
just model-test
just workspace-test
just settings-test
just report-export-test
```

Run from the repository root. Rust tests cover auth, liveness, provider payloads and usage. API verification checks real recorder reads and workspace filtering. Gateway tests use fake providers with real databases/S3, including process kills, journal recovery, outages and replay. They temporarily restart services, restore normal mode, and retain evidence. No live model calls are made.

The native Rust suite currently passes 53 tests (50 library and three stdio bridge tests); Clippy passes with warnings denied. The added asset test verifies exact embedded report-module bytes, public access, MIME, CSP, no-store and security headers. Preference cases cover typed bounds, security-field rejection, normalized retry identity, optimistic revisions and frozen admission snapshots. `just settings-test` uses real PostgreSQL and the API with the browser worker stopped to verify persisted revisions, historical UUID receipts, new-job versus exact-retry settings, restart survival and the append-only trigger. It restores original values through a new revision, cancels its unexecuted fixture jobs and checks that no model usage or recorded evidence changed. The 28 October 2026 integration run passed with zero model calls added; its result is [artifacts/exploration-settings/verification.json](../../artifacts/exploration-settings/verification.json). Pure UI configuration/comparison tests use no browser or model.

`just report-export-test` renders existing saved reports and checks representative ZIPs with an independent Python ZIP/CRC32/SHA-256 reader. It also checks manifest membership, a failed-capture gap and unchanged model-call/runtime-evidence counts. Results are recorded in [artifacts/report-export/verification.json](../../artifacts/report-export/verification.json). The final integration rendered 50 reports and checked original human-confirmed, failed-capture and replay archives. All four served assets match source and have the expected security headers. Markdown and ZIP downloads were checked in the local browser; Python independently verified the downloaded ZIP and its 16 evidence files. The browser record is [artifacts/report-export/browser-verification.json](../../artifacts/report-export/browser-verification.json).

See [cancellation](../../docs/exploration/cancellation.md) for operation IDs, dispatch fences, restart recovery and late provider settlement. `just cancellation-test` exercises these endpoints with the real local worker and simulated models.

[Human finding reviews](../../docs/exploration/finding-reviews.md) are append-only report overlays. Confirmation requires an independently reproduced, matching result with verified screenshot/metadata/artifact bytes, plus a human expectation basis and severity. Decisions do not rewrite automated assessments or training classifications.

Permanent issue history is available at `/v1/issues` and `/v1/issues/{issue_id}`. Submit `{verification_id,candidate_url}` to `POST /v1/issues/{issue_id}/verifications` and poll `/v1/issue-verifications/{verification_id}`. The same flow is exposed through `scout_get_issue`, `scout_verify_fix` and `scout_get_verification`, and the `/issues` dashboard. Verification outcomes apply to the recorded behavior on one candidate; failed or interrupted work never establishes a fix.
