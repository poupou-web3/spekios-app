---
{"title":"Verify a candidate fix","description":"Follow a permanent ScoutQA issue from its frozen expectation and original screenshots to a fresh-browser candidate verification, shared across the dashboard, MCP and REST API.","reviewed":"2026-11-03","sidebar":{"order":5}}
---
Scout assigns a permanent UUID to a completed, evidence-backed suspected behavior mismatch. That issue keeps its original expected result, actual behavior, action path and screenshot references. Repeated observations with the same page, control, viewport, project, execution mode, saved account and normalized expected/observed behavior share the ID, even when reached by a different path. Matching normalizes case and whitespace; paraphrased expectations or different failures remain separate findings for review.

## Follow an issue in the dashboard

Open **Issues & fixes** in your workspace. Select an issue to read its expected and actual behavior, reproduction steps, diagnostics link and original before/after screenshots. Choose **Copy for my agent** to preview the same Markdown description returned to API agents, then choose **Copy description**. It includes the page and control, expected and observed behavior, recorded steps, evidence references, uncertainty, decisions, tracking and CLI commands. Opening or copying the preview makes no model calls. The open preview stays frozen while the page refreshes.

**Seen in runs** shows each matching occurrence with its time, expected/observed result and a link to the run/action. **Related findings** links manually recorded duplicates and other failures on the same interface; those suggestions are not automatically treated as the same bug. Human decisions and original evidence remain available across reruns.

Enter a permitted **candidate deployment URL**, optionally label the deployment and select a saved app session. **Verify fix** queues a durable check. You can leave the page and return later. The candidate history shows each outcome, before/after evidence, reported tokens and cost separately from the original exploration.

For a protected deployment, sign in during an exploration of that candidate and save the app session. Return to the issue, refresh saved sessions and start a new check. Sessions are bound to their origin and execution mode. An old account session cannot silently cross to a different deployment origin.

## Give a coding agent the same journey

1. Discover issues in **scout_get_report** or **scout_list_issues** and save **persistent_issue_id**.
2. Read **scout_get_issue {issue_id}**. Its handoff contains the frozen expectation, observed behavior, recorded reproduction steps, browser context, diagnostics and evidence references. Use the agent's own repository access to investigate and implement the intended change.
3. Deploy the candidate, save a new UUID and call **scout_verify_fix** with **issue_id**, **verification_id** and **candidate_url**. Optional **deployment_ref** is a caller-supplied label, not an independently inspected commit.
4. Continue other work, then poll **scout_get_verification** with the saved ID. **scout_get_progress** accepts the same ID as **job_id**; **scout_get_report** includes the candidate verification result.
5. Read the same issue again to compare original and candidate evidence and usage. Use **scout_read_evidence** with the correct source or candidate run ID.

The CLI exposes the same workflow:

~~~sh
spekios issue show <issue-uuid>
spekios issue verify <issue-uuid> https://preview.example --deployment-ref <commit-sha>
spekios verification show <verification-uuid>
~~~

## Track a finding across runs

A matching failure adds an occurrence to the permanent issue and keeps its original evidence and triage decision. Existing issue IDs survive the matching upgrade. Historical IDs are not silently merged.

Tracking distinguishes **new**, **observed again**, **checking**, **verified on candidate**, **still reproducible**, **blocked** and **inconclusive**. A later failure after a successful candidate check becomes **observed again** while retaining that earlier check in history. The candidate URL and caller-supplied deployment label stay attached to each check. Scout does not infer a production fix, or a regression on the same deployment, from these labels alone.

Not seeing a bug in another exploration never closes it. Only a targeted positive candidate check can produce **resolved**, and that verdict applies to the checked deployment and preconditions.

## Understand the four outcomes

| Outcome | Meaning |
| --- | --- |
| resolved | A fresh browser completed the recorded path under matching preconditions, the recorded evidence passed integrity checks and an explicit assessment positively observed the frozen expected behavior on this candidate. |
| still_reproducible | The same failure was observed against the frozen expectation under matching preconditions. |
| blocked | Access or policy prevented checking the behavior. Sign-in inputs and private login frames are omitted. |
| inconclusive | Drift, a different failure, missing evidence, uncertain assessment, failed execution, cancellation or interruption prevented a reliable decision. |

A completed browser job alone is insufficient. No new suspicion is insufficient. Pixels changing is insufficient. Resolved does not change the original suspicion or human review, inspect the repository, establish root cause, confirm a production fix or imply complete app coverage.

## Preconditions and deployment mapping

Scout inherits the original viewport, action parameters and expected result. It maps the original entry URL to your explicit candidate entry URL and other recorded same-origin routes to the candidate origin. External routes remain subject to the existing allowlist. New native control IDs are bound only after matching the recorded page text, control states, route, viewport and authenticated/public context. Clock and date labels, and scroll within 8 pixels, still match. A changed control or meaningful page context stops dispatch and remains inconclusive. Appearance alone may change; every new screenshot and difference mask is stored independently. Fresh reproduction of a suspect uses this same comparison.

This initial implementation is deliberately conservative about content and data changes. It does not invent a replacement journey when the original preconditions cannot be reached. Both live and simulated provider modes are supported, but a simulated source cannot be silently verified using a live provider or vice versa.

## REST API and history

| Operation | Endpoint |
| --- | --- |
| Find issues | GET /v1/issues |
| Original handoff, checks and activity | GET /v1/issues/{issue_id} |
| Submit candidate | POST /v1/issues/{issue_id}/verifications |
| Read one check | GET /v1/issue-verifications/{verification_id} |

Submit **verification_id** and **candidate_url**, with optional **deployment_ref**, **auth_mode: auto/public**, **session_id**, **project_id** or **task_id**. The verification ID is also its durable job ID. Retry uncertain admission with the same UUID and identical fields; changed inputs conflict. New candidates require new IDs. Stop work using the existing job cancellation API or **scout_cancel_work**.

The handoff includes **agent_description {format: text/markdown, text}**, generated deterministically from recorded evidence without model inference. The issue includes **tracking**; **related_findings** contains up to five linked duplicates or same-interface suggestions.

Issue history returns independently paged **occurrences**, **verifications** and **history** arrays. Occurrences and activity are newest first, as are candidate checks. Each has **pagination.next_offset** and **expected_revision**. Pass the revision on later pages; a 409 means restart from offset zero. The dashboard uses these same endpoints. Reads make no model calls. Workspace boundaries and **runs:read/runs:write** permissions apply throughout.

PostgreSQL retains authoritative issue and verification records. Append-only issue lifecycle events are exported through a retryable outbox to ClickHouse. Model attempts retain request/response evidence and nullable usage; missing token or price reports stay unknown. See the [OpenAPI contract](../../openapi.json) and [tool reference](../../agents/tools/).
