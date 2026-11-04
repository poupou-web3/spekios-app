---
{
  "title": "Progress, reports and event cursors",
  "description": "Poll lightweight Spekios progress, page consistent expected-versus-actual reports and consume durable run events.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 4
  }
}
---
Use lightweight progress when you expect to wait. Fetch a report when you want recorded QA feedback. Both read existing state and do not request new inference.

## Progress routes

~~~text
GET /v1/browser-jobs/{job_id}/progress
GET /v1/runs/{run_id}/progress
~~~

Progress preserves the queue and run states, observed action/evidence counts, pending model calls, access blockers, event cursor and report retrieval instructions.

**poll_after_ms** is a pacing hint, typically 5000 while active and null when finished. No percentage or ETA is inferred from a dynamic exploration tree.

## Report routes

~~~text
GET /v1/browser-jobs/{job_id}/report
GET /v1/runs/{run_id}/report
GET /v1/runs/{run_id}/issues/{action_id}
~~~

| Query parameter | Default and bounds |
| --- | --- |
| offset | 0; integer from 0 to 100000. |
| limit | 4; integer from 1 to 10. Replies may adapt to the byte bound. |
| include_changes | true; false omits ordinary observed changes. |
| expected_snapshot | Optional 64-character hexadecimal SHA-256, supplied by continuation. |

Reports include JSON and a **markdown** field. Follow **pagination.next** as a complete tool call, or transfer its arguments to the REST query. Stop when **has_more** is false.

If the source snapshot changed, a subsequent page returns **409 report_snapshot_changed_restart_from_offset_zero**. Restart at offset zero. Human review and reproduction can change a report after browser completion.

See [report interpretation](../../agents/findings/) for categories, coverage limits and execution issues.

## Ordered events

~~~text
GET /v1/runs/{run_id}/events?after_seq=0&limit=10
~~~

Use **next_after_seq** for the next page and drain while **has_more** is true. Limits are one to one hundred. Reusing a cursor repeats that page; an empty response on a live run does not mean no future events will arrive.

This is polling, not an SSE subscription.

## Raw run and graph

**GET /v1/runs** returns a bounded recent list. **GET /v1/runs/{run_id}** reads the stored run projection. The REST graph route returns the stored graph; the agent’s **scout_get_graph** tool provides bounded array paging with one offset applied separately to states, edges, frontier and decisions.
