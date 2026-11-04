---
{
  "title": "Change the testing focus",
  "description": "Steer an active Spekios exploration from the dashboard, HTTP API or MCP and track when each version is applied to planning.",
  "reviewed": "2026-10-29",
  "sidebar": {"order": 4}
}
---
Open a running exploration and use **Testing focus** to describe what Spekios should explore next. For example: “Focus on search, filters and opening a result.” Start with a URL as usual; a testing focus is optional.

Spekios finishes assessing its current action before applying the change to its next planning decision. Existing evidence and frozen expectations keep their original meaning. Focus changes do not expand the action budget, permitted origins or access rules.

## Follow the acknowledgement

Every change receives a stable **steering_id** and a run-local **revision**. The dashboard, raw run report, progress response and agent tools expose the same history.

| Status | Meaning |
| --- | --- |
| **pending** | Saved and waiting for the next planning decision. |
| **applied** | Included in a planning decision, identified by **decision_id**. This acknowledges planner input, not completion or model compliance. |
| **superseded** | A newer request replaced it before a planning decision used it. |
| **not_applied** | Cancellation or run completion prevented a further plan, or the request arrived after execution ended. |

A request arriving during a model call waits for the next planning decision. An action already chosen retains its frozen prediction. If that was the last action, the request becomes **not_applied**. A pending request is also closed if the worker stops and recovery ends the run.

The latest applied focus remains active for subsequent planning decisions. Send an empty focus to restore ordinary exploration of likely user journeys. Each new request replaces the previous focus. Put all relevant directions in the replacement.

## Steer from an agent

Read progress to obtain **run.run_id** after a queued job starts. Then call **scout_get_steering** with **run_id** to read the current revision, including any changes from another agent or person. Follow **next_offset** with **offset** for older history; the newest page is returned first.

Save a fresh command UUID before submitting:

~~~json
{
  "name": "scout_steer_run",
  "arguments": {
    "run_id": "11111111-1111-4111-8111-111111111111",
    "steering_id": "22222222-2222-4222-8222-222222222222",
    "expected_revision": 0,
    "focus": "Focus on search, filtering, and opening a result"
  }
}
~~~

The UUIDs above are illustrative. Reuse the same UUID and identical arguments after a timeout or uncertain response. Retry receipts reflect the command’s current acknowledgement. Changed arguments with the same UUID return a conflict.

Poll **scout_get_steering** or **scout_get_progress** to see application. If **steering_revision_conflict** occurs, read the latest focus and deliberately submit a replacement with its current revision and a new UUID. Do not automatically overwrite another user’s update. The dashboard preserves edits and asks which version to use. If the revision changes while reading history pages, restart at offset zero and deduplicate by steering ID.

## HTTP API

- **GET /v1/runs/{run_id}/steering** reads the revision and paged history. Follow **next_offset** with **offset** for older pages (up to eight messages per page, newest page first).
- **POST /v1/runs/{run_id}/steering** accepts **steering_id**, **expected_revision** and **focus**, using the same semantics as MCP.

Reading requires **runs:read**; submitting requires **runs:write**. Requests use authenticated workspace ownership. The record attributes an agent submission to its agent ID. See [authentication](../../api/authentication/) and [the tool reference](../../agents/tools/).

## Scope and accounting

This version accepts up to **32 changes per run**, with **2,000 characters per focus**. It applies to exploratory runs after a run ID exists. Reproduction and candidate fix verification preserve recorded paths and reject steering. A finished exploration records a late request without restarting a browser.

Submitting or reading a focus makes no model call. The next normal planning call includes the active focus in its prompt, and the existing usage ledger accounts for those tokens. Focus events enter the durable runtime outbox for ClickHouse export. Run manifests contain the history as of publication; live API reads include later requests.

Use focus to prioritize a journey, not to supply a verdict. Each selected action still requires an observable prediction and evidence-based assessment. Keep passwords and other secrets in the [private sign-in flow](../../getting-started/private-apps/).
