---
{
  "title": "MCP and HTTP tool reference",
  "description": "Browse the thirty-four ScoutQA tools with exact Rust-generated input schemas, required fields, side effects and links to the agent workflow.",
  "reviewed": "2026-11-01",
  "sidebar": {
    "order": 5
  }
}
---
The tool reference is generated from **scout_api::agent::tools()**, the same Rust catalog used by MCP and HTTP. Each tool page lists required fields, bounds, input JSON Schema and side-effect annotations.

The [downloadable catalog](../../mcp-tools.json) is a build-time snapshot. A running server exposes its current catalog through **GET /v1/agent/tools**.

## Discover and submit

- [scout_status](../reference/scout_status/) — Inspect readiness and defaults.
- [scout_new_request_id](../reference/scout_new_request_id/) — Allocate a command UUID.
- [scout_list_projects](../reference/scout_list_projects/) — Project IDs and the model each would use.
- [scout_get_project](../reference/scout_get_project/) — One project's model and limits, even before its first run.
- [scout_start_exploration](../reference/scout_start_exploration/) — Submit a URL.
- [scout_reproduce_candidate](../reference/scout_reproduce_candidate/) — Request a fresh suspect replay.
- [scout_cancel_work](../reference/scout_cancel_work/) — Request durable cancellation.

## Change the testing focus

- [scout_get_steering](../reference/scout_get_steering/) — Read focus revisions and acknowledgement.
- [scout_steer_run](../reference/scout_steer_run/) — Replace the focus for the next planning decision.

See [testing focus](../../guides/testing-focus/) for boundaries, retries and history.

## Follow work and retrieve feedback

- [scout_get_progress](../reference/scout_get_progress/) — Lightweight asynchronous progress.
- [scout_get_report](../reference/scout_get_report/) — Paged coding-agent handoff.
- [scout_get_issue](../reference/scout_get_issue/) — One detailed finding.
- [scout_get_job](../reference/scout_get_job/) — Durable queue detail.
- [scout_list_runs](../reference/scout_list_runs/) — Recent owned runs.
- [scout_get_run](../reference/scout_get_run/) — Compact recorded run.

## Decide and recheck

- [scout_list_knowledge](../reference/scout_list_knowledge/) — Known bugs and intended behavior for a site.
- [scout_get_app_map](../reference/scout_get_app_map/) — States, transitions and untried controls carried between runs.
- [scout_compare_run](../reference/scout_compare_run/) — What a run found that earlier runs did not, and what changed.
- [scout_triage_issue](../reference/scout_triage_issue/) — Decide whether an issue is a bug, intended behavior or a duplicate.
- [scout_recheck_deployment](../reference/scout_recheck_deployment/) — Verify a deployment against every open issue.
- [scout_get_recheck](../reference/scout_get_recheck/) — Per-issue outcomes of a recheck.

See [triage and rechecks](../../guides/triage/) for what each decision changes and how CI uses rechecks.

## Inspect evidence and context

- [scout_list_findings](../reference/scout_list_findings/) — Original candidates and human dispositions.
- [scout_get_action](../reference/scout_get_action/) — One recorded action.
- [scout_get_graph](../reference/scout_get_graph/) — States, transitions and frontier.
- [scout_get_events](../reference/scout_get_events/) — Ordered event cursor.
- [scout_read_evidence](../reference/scout_read_evidence/) — Verified capture or artifact.
- [scout_usage](../reference/scout_usage/) — Nullable provider-reported usage.
- [scout_access_requests](../reference/scout_access_requests/) — Human access blockers.

## Shared rules

Unknown fields and nil UUIDs are rejected. Selector rules such as “exactly one job ID or run ID” are also validated by the dispatcher; a property table alone does not express all runtime requirements.

Structured replies are capped at 128 KiB, requests at 64 KiB, returned PNGs at 4 MiB and JSON artifacts at 128 KiB including metadata. Reduce page sizes after an oversized response. Use ordinary download endpoints for larger evidence.

Starting exploration or reproduction can change data on the target site and consume configured model usage. Read tools make no model calls. Tool annotations describe those properties; they are not a security policy.

Continue with the [agent workflow](../workflow/) or [HTTP call contract](../../api/agent-tools/).
