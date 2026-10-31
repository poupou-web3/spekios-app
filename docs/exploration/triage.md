# Triage, known behavior and deployment rechecks

Triage closes Scout's loop: the agent decides what is wrong, Scout records it, people see it, and the requesting agent or CI job gets an answer. It sits on top of [permanent issues](../../apps/docs/src/content/docs/guides/fix-verification.md) and never rewrites evidence, model assessments or [human finding reviews](./finding-reviews.md). The user guide is [Triage findings and recheck a deploy](../../apps/docs/src/content/docs/guides/triage.md).

## Decisions

`issue_triage` ([021-issue-triage.sql](../../infra/postgres/021-issue-triage.sql)) holds append-only revisions per issue: `bug`, `intended_behavior`, `duplicate` (with `duplicate_of`) or `needs_review`, a rationale, and the actor:

| Actor | Source | May replace |
| --- | --- | --- |
| `human` | Workspace UI or a human REST request | Any decision |
| `agent` | `scout_triage_issue`, or any request with an agent credential | Agent and Scout decisions |
| `system` | Scout, when a new issue matches known behavior | Nothing; it only triages new issues |

`scout_triage_issue(...)` is the single write path. It locks the issue, resolves `duplicate_of` to its canonical issue (refusing cycles), returns an identical current decision as `reused`, checks `expected_revision`, and refuses `human_decision_present` when an agent would replace a person. Each revision bumps the issue revision and appends an `issue.triaged` event, exported to ClickHouse with the other issue events.

Finding reviews stay separate: they label one action's evidence (with reproduction requirements for confirmation and training implications). Triage decides what Scout does next with an issue.

## Behavior identity and known behavior

An issue's fingerprint keeps its whole recorded path, so different paths to the same bug were separate issues. `issue_behaviors` adds a looser behavior key: the page URL of the before capture without its fragment, the command identity, the viewport profile and whether the action ran signed in. Migration 021 also strips `in_viewport`, `page_y` and `ambiguous` from the command identity: they describe scroll position and layout, and made one behavior at two scroll positions two issues.

When `scout_record_issue` creates a new issue, it records the behavior key and looks for another issue of the same owner with that key whose current decision is `bug`, `intended_behavior` or `duplicate`, taking the newest decision. The new issue is then triaged by `system`: intended behavior stays intended behavior; a bug or duplicate makes it a duplicate of the canonical issue. The existing issues get behavior keys when the migration runs; no decisions are invented for them.

`GET /v1/knowledge` and `scout_list_knowledge` list canonical decisions (bug or intended behavior, not Scout's own matches), with page, control, viewport, sign-in state, and duplicates, matches and occurrences rolled up.

## Reports

Run reports carry each persistent issue's current triage. The coding-agent report adds a `triage` object to every packet (`status`, `known_behavior`, who decided, rationale, `duplicate_of`, `matched_issue_id`), counts suspected bugs by triage in `summary.triage`, sets `finding_source.creates_new_finding` false for known behavior and gives no repair objective for intended behavior. `GET /v1/issues?triage=open` returns untriaged, needs-review and bug issues; the workspace issues page defaults to it.

## Recheck after a deploy

`POST /v1/rechecks` (`scout_recheck_deployment`) takes a `recheck_id`, the deployment `candidate_url`, an optional `source_origin` (default: the candidate origin) and an optional `deployment_ref`. One statement selects up to 25 open issues of that origin, newest first, and records an immutable `issue_rechecks` row. Each issue is then admitted as an ordinary fix verification on the candidate origin with the issue's entry path and query. Verification IDs are derived from the recheck and issue IDs, so a retry with the same `recheck_id` reuses admitted jobs and only admits the rest. Transient refusals (database, provider, queue) return 503 without recording the item; permanent ones record a skip reason. The recheck may exceed the ordinary ten-job queue limit by its own size.

`GET /v1/rechecks/{id}` (`scout_get_recheck`) summarizes each item's verification and counts resolved, still reproducible, blocked, inconclusive, pending and skipped checks; `complete` is true once every admitted check has an outcome. [scripts/scout-recheck.mjs](../../scripts/scout-recheck.mjs) starts a recheck, waits and exits 0, 1 (regression, or with `--strict` any unconfirmed item), 2 (refused) or 3 (timeout). `just recheck URL` runs it against the local stack.

## Verification

- `cargo test` covers triage input rules, candidate URL derivation and stable verification IDs; `apps/web/test/issues.test.mjs` covers the triage form, conflicts, the open filter and recheck retries.
- An end-to-end check against an isolated API and database covered: human triage and identical retries; automatic recognition across a different path and scroll position; agent triage refused over a person's decision; automatic duplicates, cycle and stale-revision refusals; the open list and knowledge roll-ups; report labels and counts; recheck admission, reuse, conflict and origin refusal; and the CI script's exit code on a regression.
- Not yet covered by the fixture suites: rechecks executed by a real worker, and triage written from an agent credential over REST.
