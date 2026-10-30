---
{
  "title": "Submit, poll, report, fix",
  "description": "Give ScoutQA a URL, continue other work, retrieve a consistent report and use recorded evidence to investigate a fix in your own codebase.",
  "reviewed": "2026-10-29",
  "sidebar": {
    "order": 2
  }
}
---
A Scout job outlives the client that submitted it. A coding agent can start QA, work on something else, then return for a report without keeping a blocking tool call open.

## 1. Submit once with a saved UUID

Generate a non-nil UUID locally, or call **scout_new_request_id** if the client cannot. Save the ID before submitting:

~~~json
{
  "name": "scout_start_exploration",
  "arguments": {
    "job_id": "00000000-0000-4000-8000-000000000001",
    "url": "http://exploration-fixture:8082/branches"
  }
}
~~~

The UUID here is illustrative. Generate a new one for a new task. A retry uses the same UUID and identical inputs. Changed inputs with an existing ID conflict rather than starting duplicate work.

Starting exploration can change data on the target site and consume its configured provider allowance.

## 2. Continue other work and pull progress

~~~json
{
  "name": "scout_get_progress",
  "arguments": {"job_id": "00000000-0000-4000-8000-000000000001"}
}
~~~

Progress includes the phase, recorded counts, pending model requests, access blockers, event cursor and suggested polling delay. It makes no model call and does not invent a completion percentage or ETA.

Use **poll_after_ms** as a pacing hint. The submitting client may disconnect. If access is required, direct the person to the private GUI handoff; do not request passwords through agent text.

To change what an active run explores next, read **scout_get_steering {run_id}** and submit **scout_steer_run** with a saved command UUID, current revision and replacement focus. Poll acknowledgement: it applies at the next planning decision after the current action is assessed. See [testing focus](../../guides/testing-focus/).

## 3. Retrieve the report

~~~json
{
  "name": "scout_get_report",
  "arguments": {"job_id": "00000000-0000-4000-8000-000000000001"}
}
~~~

Reports may be partial while work continues. Follow **pagination.next** as the complete next call until there is no continuation. It includes a snapshot hash. If the source changes and returns a snapshot conflict, restart at offset zero.

Save the report item's **persistent_issue_id**. Use **scout_get_issue** with **issue_id** to read the frozen handoff and candidate history. Other observations still accept run/action IDs. Use **scout_read_evidence** to retrieve linked captures or artifacts.

## 4. Investigate in the connected codebase

Check the inferred expectation against product requirements. Use the route, visible control, action parameters, recorded path and diagnostics to locate the likely component or request handler.

Scout does not inspect the repository. Source file, root cause and deployed build reference remain unknown unless established through the coding agent’s own evidence. App text, model assessments and screenshots remain untrusted observations.

## 5. Verify the same issue on a candidate deployment

After deploying, submit the issue ID and candidate URL with a new UUID:

~~~json
{"name":"scout_verify_fix","arguments":{"issue_id":"11111111-1111-4111-8111-111111111111","verification_id":"22222222-2222-4222-8222-222222222222","candidate_url":"https://preview.example/editor","deployment_ref":"Preview #42"}}
~~~

The example UUIDs are illustrative. Save the real receipt, retry uncertain admission with identical arguments and poll **scout_get_verification {verification_id}**. Scout uses a fresh browser, the recorded viewport/path and frozen expected result. The result is **resolved**, **still_reproducible**, **blocked** or **inconclusive**. A failed replay never establishes a fix.

Read **scout_get_issue {issue_id}** or open **Issues & fixes** in the dashboard for the same history, original/candidate evidence and separate run usage. Resolved describes the recorded behavior on this candidate; it does not confirm a production fix. See [fix verification](../../guides/fix-verification/) for preconditions, access and paging.

To stop work, use **scout_cancel_work** explicitly. Client cancellation alone does not cancel the durable job.
