---
{
  "title": "Create and cancel browser jobs",
  "description": "Submit URL exploration or suspect reproduction to Spekios with idempotent UUIDs, frozen settings and durable cancellation.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 3
  }
}
---
Browser work is asynchronous. **POST /v1/browser-jobs** admits a durable command; it does not wait for the browser to finish.

## Submit an exploration

~~~sh
curl --fail-with-body \
  --header "Authorization: Bearer $SPEKIOS_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "job_id":"00000000-0000-4000-8000-000000000001",
    "kind":"explore",
    "target_url":"https://your-app.example/",
    "viewport_profile":"desktop",
    "auth_mode":"auto",
    "auto_reproduce":false
  }' \
  "$SPEKIOS_SERVER/v1/browser-jobs"
~~~

**auth_mode: public** means signed-out testing. It does not publish the run; recordings remain workspace private.

Generate your own new job UUID; the value above is illustrative. The HTTP tool equivalent uses **url** instead of REST’s **target_url**. See [authentication](../authentication/) for credentials.

| Field | Rules |
| --- | --- |
| project_id / task_id | Optional non-nil correlation UUIDs. They do not grant ownership or select another workspace. |
| job_id | Required, non-nil UUID. Save it before sending. |
| kind | Required: explore or reproduce. |
| target_url | Required for explore, up to 2048 bytes; any HTTP(S) URL without embedded credentials. Loopback hosts are rewritten to **host.docker.internal** so the containerized browser reaches the Docker host (your computer on a local installation). |
| viewport_profile | Optional for explore: desktop, tablet or mobile. |
| auth_mode | Optional for explore: auto, sign_in or public. |
| session_id | Optional owned, compatible app session; cannot be used in public mode. |
| auto_reproduce | Optional for explore; overrides the admitted default. |
| app_memory | Optional boolean for explore; overrides the saved [app memory](../models-usage/#app-memory) default. |
| model | Optional **provider** and **model**, with optional **provider_key_id** and **free_only**. Overrides the project's model for this job. |
| continue_from_run_id | Optional for explore. The owned run must be a failed, interrupted or cancelled exploration, and the target URL and viewport must match it. The new job starts from the graph that run explored, reopens the page where it stopped, and does not repeat a dispatched action. It uses the current model and limits for the additional work. A chain can be continued any number of times. An already queued continuation of that run is reused. |
| source_action_id | Required for reproduce; prohibited for explore. |

A reproduction submission contains **job_id**, **kind: reproduce** and **source_action_id**, plus optional correlation labels and **model**. It inherits the source attempt’s context; exploration overrides are rejected.

## Admission and retries

A new job returns **202 Accepted**. Identical ID/input retries return **200 OK** with the original admission. Reusing the ID with different normalized inputs returns **409 Conflict**.

Defaults and their revision are frozen at admission. A workspace can have at most ten queued or running jobs; more return **409 browser_queue_full**. Provider availability, saved sessions and replay eligibility are checked.

A lost client response is not permission to create a new ID. Retry the saved command or read its job record first.

## Read a durable job

- **GET /v1/browser-jobs** — Recent queue listing.
- **GET /v1/browser-jobs/{job_id}** — One owned job, without the recent-list limit.
- **GET /v1/browser-jobs/{job_id}/progress** — Lightweight progress.
- **GET /v1/browser-jobs/{job_id}/report** — Coding-agent feedback.

## Issues, fix verification and rechecks

Persistent issues have their own routes. Request bodies match the [scout_verify_fix](../../agents/reference/scout_verify_fix/), [scout_triage_issue](../../agents/reference/scout_triage_issue/) and [scout_recheck_deployment](../../agents/reference/scout_recheck_deployment/) tool schemas, except that **issue_id** goes in the path.

- **GET /v1/issues** and **GET /v1/issues/{issue_id}** — List issues; read one with its handoff and history.
- **POST /v1/issues/{issue_id}/verifications** — Check a candidate deployment; read **GET /v1/issue-verifications/{verification_id}**.
- **POST /v1/issues/{issue_id}/triage** — Record a triage decision. **GET /v1/knowledge** lists known behavior.
- **POST /v1/rechecks** — Verify a deployment against open issues; read **GET /v1/rechecks/{recheck_id}**.

See [fix verification](../../guides/fix-verification/) and [triage and rechecks](../../guides/triage/).

## Stop work

Send a POST with no body to:

- **/v1/browser-jobs/{job_id}/cancel**
- **/v1/runs/{run_id}/cancel**
- **/v1/runs/{run_id}/automatic-reproductions/cancel**

Cancellation is durable. Poll for acknowledgement; retained evidence and late provider usage remain available.
