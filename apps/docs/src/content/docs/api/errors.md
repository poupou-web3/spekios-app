---
{
  "title": "Errors, limits and safe retries",
  "description": "Handle Spekios validation, authentication, admission conflicts, snapshot changes, unavailable evidence and bounded responses.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 8
  }
}
---
Keep the original command ID when retrying an uncertain admission. A timeout can occur after the server has already accepted work.

## Common HTTP statuses

| Status | Typical meaning and next step |
| --- | --- |
| 400 | Invalid arguments, unsupported values or a cross-field constraint. Correct the request. |
| 401 | Missing, invalid, expired or revoked credential, or an MCP OAuth token used outside **/mcp** (**invalid_token_audience**). Reconnect or check secret configuration. |
| 402 | **demo_credits_insufficient**: the demo allowance cannot cover the call. Use a personal provider key. |
| 403 | **insufficient_scope** or **request_origin_not_allowed**. Do not bypass it. |
| 404 | The selected owned record or tool is unavailable. Check IDs and run binding. |
| 409 | Command input/revision conflict, report snapshot change, full browser queue (**browser_queue_full**), unconfigured provider or evidence not yet available. Follow the specific error. |
| 413 | Request or bounded result too large. Reduce page size or use a download endpoint. |
| 429 | Polling or registration too fast (for example **slow_down** during pairing). Wait and retry. |
| 503 | A required service, database or evidence path is unavailable. Retry later or inspect operations. |

Framework-level parsing errors can differ from Spekios’s JSON domain-error shape. Do not assume every non-2xx response has identical fields.

## Command conflicts

For exploration, reproduction, fix verification, rechecks, testing-focus changes, model requests and settings saves, a stable UUID identifies one command. Identical normalized input can reuse it; changed input conflicts.

On a lost response, read the command record or retry the saved request. Generate a fresh UUID only when intentionally starting new work.

Reproduction additionally follows the source action’s once-per-candidate rule. A new UUID does not bypass eligibility.

## Report conflicts

**report_snapshot_changed_restart_from_offset_zero** means the underlying recording/review snapshot changed between report pages. Restart from the first page instead of combining incompatible pages.

## Cancellation is explicit

A transport timeout, aborted tool call or disconnected client does not cancel a durable job. Use the cancellation tool/route and inspect acknowledgement.

## Bounds

- Protected request bodies and MCP stdio lines: 64 KiB.
- Structured agent replies: 128 KiB.
- Agent-returned PNG: 4 MiB.
- Agent-returned JSON artifact including metadata: 128 KiB.
- Report page: 1–10 items, default 4.
- Event page: 1–100 items, default 10.
- Agent graph arrays: 1–50 per array, default 20.
- Session history: 1–50 runs, default 20; offset up to 100,000.

Read the [OpenAPI contract](../../openapi.json) and exact [tool schemas](../../agents/tools/) for operation-specific bounds.
