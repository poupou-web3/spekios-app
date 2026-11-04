# Triage, known behavior and deployment rechecks

Triage closes Spekios's loop: the agent decides what is wrong, Spekios records it, people see it, and the requesting agent or CI job gets an answer. It sits on top of [permanent issues](../../apps/docs/src/content/docs/guides/fix-verification.md) and never rewrites evidence, model assessments or [human finding reviews](./finding-reviews.md). The user guide is [Triage findings and recheck a deploy](../../apps/docs/src/content/docs/guides/triage.md).

## Decisions

`issue_triage` ([021-issue-triage.sql](../../infra/postgres/021-issue-triage.sql)) holds append-only revisions per issue: `bug`, `intended_behavior`, `duplicate` (with `duplicate_of`) or `needs_review`, a rationale, and the actor:

| Actor | Source | May replace |
| --- | --- | --- |
| `human` | Workspace UI or a human REST request | Any decision |
| `agent` | `scout_triage_issue`, or any request with an agent credential | Agent and Spekios decisions |
| `system` | Historical automatic matches retained for audit | Nothing; it only triages new issues |

The PostgreSQL function `scout_triage_issue(...)` is the single write path (the MCP tool of the same name calls it through the API). It locks the issue, resolves `duplicate_of` to its canonical issue (refusing cycles), returns an identical current decision as `reused`, checks `expected_revision`, and refuses `human_decision_present` when an agent would replace a person. Each revision bumps the issue revision and appends an `issue.triaged` event, exported to ClickHouse with the other issue events.

Finding reviews stay separate: they label one action's evidence (with reproduction requirements for confirmation and training implications). Triage decides what Spekios does next with an issue.

## Behavior identity and known behavior

Issues are matched through append-only `issue_signatures` aliases ([029-issue-handoff-history.sql](../../infra/postgres/029-issue-handoff-history.sql)). The version-2 signature covers the page URL without its fragment, normalized command identity, viewport profile and dimensions, project, execution mode, saved auth session (or isolated auth context), and case/whitespace-normalized expected and observed results. Missing observations are isolated by action ID. A per-owner/signature advisory lock serializes concurrent observations.

Strict matches append an occurrence and lifecycle event to that issue, retaining human decisions. Historical separate IDs remain accessible. A changed failure stays untriaged even on a previously intended control: the loose `issue_behaviors` key supplies bounded related-finding suggestions, not automatic triage inheritance. Manual duplicates retain canonical links.

`scout_issue_tracking` combines latest observation and candidate check without claiming a global fix. A completed positive candidate check is `verified_on_candidate`; a later observation is `observed_again`. Absence in an exploration has no lifecycle effect. The API returns occurrences/activity newest first and exposes tracking in issue summaries and run handoffs.

`GET /v1/issues/{id}` and `scout_get_issue` share `handoff.agent_description`: bounded deterministic Markdown generated from structured evidence, including uncertainty and review decisions. The UI previews and copies this exact string without inference; an open preview is outside the polling root and remains frozen. The CLI exposes `issue show`, durable `issue verify`, and `verification show`.

`GET /v1/knowledge` and `scout_list_knowledge` list canonical decisions (bug or intended behavior, not Spekios's own matches), with page, control, viewport, sign-in state, and duplicates, matches and occurrences rolled up.

## Reports

Run reports carry each persistent issue's current triage. The coding-agent report adds a `triage` object to every packet (`status`, `known_behavior`, who decided, rationale, `duplicate_of`, `matched_issue_id`), counts suspected bugs by triage in `summary.triage`, sets `finding_source.creates_new_finding` false for known behavior and gives no repair objective for intended behavior. `GET /v1/issues?triage=open` returns untriaged, needs-review and bug issues; the workspace issues page defaults to it.

## Recheck after a deploy

`POST /v1/rechecks` (`scout_recheck_deployment`) takes a `recheck_id`, the deployment `candidate_url`, an optional `source_origin` (default: the candidate origin) and an optional `deployment_ref`. One statement selects up to 25 open issues of that origin, newest first, and records an immutable `issue_rechecks` row. Each issue is then admitted as an ordinary fix verification on the candidate origin with the issue's entry path and query. Verification IDs are derived from the recheck and issue IDs, so a retry with the same `recheck_id` reuses admitted jobs and only admits the rest. Transient refusals (database, provider, queue) return 503 without recording the item; permanent ones record a skip reason. The recheck may exceed the ordinary ten-job queue limit by its own size.

`GET /v1/rechecks/{id}` (`scout_get_recheck`) summarizes each item's verification and counts resolved, still reproducible, blocked, inconclusive, pending and skipped checks; `complete` is true once every admitted check has an outcome. [scripts/scout-recheck.mjs](../../scripts/scout-recheck.mjs) starts a recheck, waits and exits 0, 1 (regression, or with `--strict` any unconfirmed item), 2 (refused) or 3 (timeout). `just recheck URL` runs it against the local stack.

## Tests

- `just api-test` covers triage input rules, candidate URL derivation and stable verification IDs; `just web-test` (`apps/web/test/issues.test.mjs`) covers the triage form, conflicts, the open filter and recheck retries.
- `just finding-handoff-test` uses disposable PostgreSQL, real Chromium captures and the installed CLI to check identity migration, concurrent occurrences, scope separation, retained review/evidence, candidate tracking, exact API/preview/copy equality, polling, account isolation and durable candidate admission and cancellation. It makes no model calls.
- Not covered by automated suites: rechecks executed by a real worker, and triage written from an agent credential over REST.
