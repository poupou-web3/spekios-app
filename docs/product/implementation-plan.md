# Product requirements and implementation plan

Prepared 14 October 2026; consistency review 21 October 2026. This is the product design for Scout QA, informed by the seven supplied screenshots. It specifies this application's behavior, schema, and interfaces.

## Where this stands

The current state and the decisions on each spec item (sessions, test cases and verdicts, knowledge base, triage, budgets, schedules and CI) are in [Building the Scout QA agent](./architecture.md#where-this-stands-31-october-2026). This document remains the design; dated implementation notes are in the [change log](#change-log) at the end.

## 1. What the references establish

### Observed in the supplied screenshots

| Surface | Observation | Requirement for our product |
|---|---|---|
| Navigation | New session, Sessions, Schedules, Workspace, Environments, Knowledge base, Settings | Maintain persistent sessions; add supporting configuration after the core testing loop works. |
| Session header | App name, case/verified/bug counts, amount spent | Derive counts from authoritative server state; show spend with its update timestamp. |
| Split workspace | Conversation and action groups on the left; Agents / Test cases / Bugs on the right | Keep user intent and evidence visible together; make each panel independently navigable. |
| Agent queue | One GMGN snapshot shows 172 agents: 27 running, 123 waiting, 22 finished | These are task records across states, not proof of 172 simultaneous browsers. Show queued and active capacity separately. |
| Agent rows | Role, current action, elapsed time, case count, search and status filters | Every row opens its scoped transcript and evidence; distinguish queue time from active time. |
| Case rows | Named behavior, description, status filters; some say “Waiting for capacity” | Separate execution state from verdict so a queued case cannot appear verified or actively executing. |
| Bug rows | Description and review selection | Add detail with expected/actual behavior, reproducible steps, paired screenshots, source case, and triage history. |
| Access blocker | Login card offers “Provide secret”; public exploration can continue | A blocker pauses only dependent work; collect access through a dedicated secret input. |
| Replay | Live or recorded screen link | Preserve the exact attempt, action, and screenshot timeline behind each observation; our V1 uses screenshots rather than default video. |

The screenshots show a working information architecture but cannot establish backend technology, model providers, quality rates, cost efficiency, or the reproducibility of their particular findings. Visible tool labels are observations, not instructions to this project.

### Product behavior

The product uses a session agent, explore agents, case-execution (“bug bash”) agents, and separate reproducer agents. An explorer proposes cases and suspects issues; a functional bug requires a clean, independent reproduction. Each sub-agent receives its own browser or device, with a concurrency cap. A run tests a running target. Repository access, when present, is read-only context and does not itself generate repository test files.

Reports distinguish case definitions, verdicts, coverage gaps, reproduced bugs, and static screenshot findings. A case without a verdict remains unverified; zero reported bugs does not establish complete coverage. Reports include expected and actual behavior, steps, and evidence metadata.

Sessions support selectable environments, sensitive variables, shared authentication setup, concurrency settings, and scheduled runs. Schedules use a prompt, cron expression, time zone, environment, and concurrency setting, with a new session for each occurrence. Agent runtime, browser time, and inference contribute to cost.

Triage decisions include accepted, intended behavior, cannot reproduce, and duplicate. Intended behavior can become a reviewed knowledge entry for later sessions.

The workspace and agent interface support asynchronous session start, messages, status, report export, cost, stop, and file transfer. A start response returns before the work finishes. Private or local targets can be reached through a tunnel scoped to specified addresses.

## 2. Product scope and priorities

### P0 — a trustworthy web testing loop

1. Create a session with a reachable web URL as the only required input. Apply configured defaults for viewports, provider, action policy, and budgets. A brief, credentials, environment, or known requirements are optional enrichments, never prerequisites for public discovery.
2. Stream a session transcript and a server-backed task list. Show plan changes, what is being checked, and why progress stopped.
3. Infer likely goals from page structure, visible copy, controls, routes, and prior observations. Build a state/action/flow graph and select the next flow by business importance, novelty, risk, uncertainty, and remaining budget. Label inferred goals and criteria with their evidence and confidence rationale.
4. Before each browser action, persist the planned action and predicted outcome, then capture uniquely identified before and after screenshots. Capture a difference mask and relevant DOM, URL, network, console, timing, and viewport context. Assess every action, including waits, errors, no change, and minimal change.
5. Treat a mismatch as a candidate. Independently reproduce a suspected functional bug and establish a defensible expected behavior before promotion. Repeated disagreement with an inferred goal alone does not prove a defect.
6. Keep static findings, infrastructure failures, blocked cases, and unverified coverage distinct.
7. Offer a private credential input and a user-driven test-account creation path when authentication blocks a flow. Continue other accessible work. Never automatically purchase, pay, subscribe, or connect/use a wallet to obtain access.
8. Show confirmed findings with evidence; accept, dismiss with reason, mark duplicate, or request a recheck.
9. Export a versioned JSON and Markdown report, with explicit incomplete coverage and artifact availability.
10. Enforce bounded concurrency, full-session cancellation, and budget admission before dispatch. Record usage per provider call/action/attempt even when work fails or yields no new state.
11. Provide bring-your-own API-key adapters for Claude, OpenAI and OpenRouter. OpenRouter free-only mode checks image/tool capabilities, records the actual routed model/provider, handles quotas, and forbids paid fallbacks. Offer an OpenAI local-app subscription route only for eligible accounts with explicit token-sharing consent, using its documented public API restrictions. Keep native agent-runner adapters separate and capability-gated; a provider subscription does not generically confer API access. An unmodified Claude Code binary can retain its own supported native authentication; custom Claude API/SDK integrations use API keys or supported cloud authentication and must not collect/proxy Claude account OAuth credentials. Provider-specific sources, restrictions, and validation live in [model connections](../platform/models.md).
12. Preserve action and assessment lineage in ClickHouse and artifact manifests so reviewed examples can later form training/evaluation datasets. Collection is not automatic permission to train.

### P1 — repeatable team use

Multiple saved environments and role-specific accounts; reviewed knowledge entries; recurring sessions; report comparisons; expanded application revision capture; reusable account/data fixture libraries; notifications on completed or actionable runs; test-case promotion into a reviewed reusable suite. Basic fixture isolation is required in P0 for any mutable flow. Shared hosted deployment additionally requires authenticated workspace membership, tenant isolation, secret management, operational recovery, and an audit trail.

### P2 — platform expansion

Native iOS/Android, multi-browser engines, customer-network tunnel, PR diff-based selection, repository test authoring and repair, external issue trackers, continuous video, and enterprise network deployment. Difference-mask evidence is part of V1, not a later visual-comparison feature.

### Initial operating assumptions

The implementation runs locally with Chromium. The deterministic recorder fixture uses one desktop viewport; the URL explorer supports desktop/tablet/mobile profiles and a sequential three-profile command. The working Compose stack contains the Rust API, TypeScript browser worker, PostgreSQL, ClickHouse, and SeaweedFS, with named volumes preserving results across restarts. Jobs are claimed directly from PostgreSQL; additional delivery infrastructure is optional. Use just for local commands and add Kubernetes parity after service/isolation contracts stabilize, without implicitly migrating the existing evidence volumes. A Rust image-processing port remains a separate profiling decision.

Concurrency, action/time/spend limits, and an explicit reproduction reserve are configurable defaults. Begin with one worker while proving correctness, then raise bounded parallelism through measured milestones. Do not impose a promised case count: prioritize useful graph branches until a limit or a documented stopping condition is reached. Use controlled apps with disposable data for acceptance tests. Native app testing, purchases, subscriptions, wallet operations, and bypassing anti-bot challenges are outside V1 autonomous actions.

## 3. Primary UX flows

### Start and steer

New session opens a URL field and a Start button. Optional settings stay in a drawer; provider credentials can be configured once at the workspace/developer level. On Start, the system validates reachability, loads the page, reads visible content and controls, and begins discovery. It does not ask the user for a test brief to get started.

The session shows inferred product purpose and likely flows as provisional statements: for example, “This appears to be a trading dashboard; likely goals include finding a token and comparing its activity.” Record the supporting UI evidence, uncertainty, and alternatives. Optional user corrections update the intent revision. A goal is not converted to a product requirement merely because an agent proposed it.

The session page has a persistent header and resizable conversation/results panels. Transcript entries distinguish user messages, agent updates, grouped tool actions, access requests, and summary cards. User messages steer the coordinator at a safe tool boundary. Already running work retains its original scope revision until explicitly cancelled or superseded. Show that revision in its detail view.

### Explore flows and assess every step

Represent a flow as a goal hypothesis and a path through states, with branches for alternative inputs, roles, viewports, and outcomes. Preserve every captured observation; grouping similar states is a revisable planning projection, not deletion of small changes. Discrete screenshots cannot guarantee every transient frame was observed; record capture timing and gaps. The scheduler ranks frontier branches by expected usefulness: important user goals and risky behavior, newly discovered states/controls, unresolved uncertainty, and estimated execution/reproduction cost. Similarity and loop detection reduce repeated paths. Log the score components and selection reason so a reviewer can understand why a flow was or was not explored.

Each attempted step follows this contract:

1. Allocate `actionId` linked to `sessionId`, `runId`, `flowId`, `stateId`, `taskId`, and `attemptId`. Persist the intended action, target, predicted result, intent source, and observation criteria before dispatch.
2. Capture `beforeCaptureId` and the before-state context. Capture IDs are unique even when their image bytes match an earlier capture; content hashes may deduplicate storage without conflating observations. Missing before evidence prevents dispatch.
3. Execute the typed browser action. Waits, retries, timeouts, cancelled dispatches, and browser errors are first-class attempts with their own status and causal links.
4. Capture `afterCaptureId`, a `diffMaskArtifactId`, and after-state context. Preserve unmasked evidence and any dynamic-region mask rationale. If capture fails, record an explicit capture failure; do not fabricate a screenshot reference.
5. Compare predicted and observed results using visual changes plus DOM, URL, network, console, timing, and product context. Record separate dimensions: `changeClass` (`no_change`, `minimal_change`, `material_change`, `unknown`), `expectationMatch` (`matched`, `mismatched`, `inconclusive`), and execution outcome (`succeeded`, `blocked`, `timeout`, `cancelled`, `error`). Include the reason, evidence IDs, and remaining uncertainty. This allows correct no-change and incorrect no-change to remain distinguishable.
6. Add the observed state/transition to the graph, update frontier priorities, and decide whether to continue, wait within a bound, try an alternative, request access, or schedule reproduction. A missing capture or failed check blocks this worker's next interaction until recovery or a terminal evidence-gap result; other independent workers may continue.

No change can be correct, such as clicking a disabled control or applying a filter that already matches. A small change can be decisive, such as an error label or changed total. A large screenshot difference can be an animation or unrelated live data. The visual difference is evidence, not a verdict. Every step is assessed even when it reveals no new state.

### Read progress accurately

Agents tab: filter by role and execution status. A row shows title, role, queued duration, active duration, latest meaningful action, related cases, and attempts. “Waiting for capacity” is different from “Needs access” and “Waiting for dependent task.” The UI never simulates work by incrementing counters on a timer.

Test cases tab: search across titles and expected behavior; filter execution status and verdict independently. A case detail contains the originating flow/goal hypothesis, conditions, ordered outline, intent provenance, assertions, latest verdict, prior attempts, checked controls, and remaining gaps. Display “Not checked” until evidence exists. “Issues found” does not automatically increment the confirmed bug count. A flow graph and action timeline expose all attempts, including waits and failures.

Bugs tab: keep separate filters for Confirmed bugs, Static findings, and Candidates. A row opens an evidence panel with the exact environment/revision/viewport, expected/actual behavior and its justification, original and reproduction attempts, screenshot timeline, difference overlay, and triage actions. Counts use distinct finding identities after deduplication. Candidates with unresolved intended behavior remain explicitly uncertain even if the observed behavior reproduces.

### Resolve a blocker

The coordinator posts one actionable request that identifies the affected flows and missing account, data, or decision. Offer “Provide credentials” and “Create a test account in the app,” where the second opens the target's signup flow for the user and explains how to resume. Automated registration is a separate user-authorized action, not an implicit consequence of entering a URL. Never purchase, submit payment, subscribe, connect a wallet, or sign a wallet transaction to gain access. A paywall remains an access gap until the user supplies appropriate access.

The user can also add context, skip the affected coverage, or stop. Resolve access once and fan the new reference out to eligible waiting jobs. Unrelated public flows continue while the request is pending. Keep secrets out of messages, screenshots where possible, and model context except through the specific execution mechanism that needs them. Retain partial results and name every unresolved coverage gap.

### Finish and recheck

Final summary shows inferred/discovered scope, explored and remaining flows, verified cases, issues found, blocked/unverified cases, confirmed bugs, uncertain candidates, static findings, and usage/cost. The terminal outcome is Checked scope clean, Findings to review, Incomplete, Cancelled, or Infrastructure failure. “Checked scope clean” is explicitly limited to evaluated criteria; it never means the whole app is bug-free. It requires no unresolved mandatory criteria or suspects and no active jobs. Budget-limited graph branches remain visible as unexplored coverage.

Recheck creates a new run against a specified deployment revision. Reuse the case and reproduction recipe, but preserve prior verdicts and evidence. A bug is “Fixed in revision X” only after a new successful attempt. Do not overwrite history or silently weaken its acceptance criterion.

### Learn and schedule

“Works as intended” requires a reason and offers a scoped knowledge draft. Save it only after review. Entries record environment, roles, routes, applicable version or expiry, and provenance so an old exception cannot suppress unrelated defects.

A schedule stores the URL, optional goals, settings, and an IANA time zone, displays next run times, and starts a new session per occurrence. Define overlap behavior explicitly: default to skip a new occurrence while the previous scheduled run remains active. A missing selected environment produces a visible failed launch. “Run now” uses the same configuration as recurrence.

## 4. Domain model

PostgreSQL owns transactional run state, leases, decisions, budgets, and durable outbox events. ClickHouse receives an append-only analytical stream of every state/action/assessment/provider-call event, including failed and repeated attempts. It is not used to authorize actions, enforce budgets, or decide whether a run is complete. S3-compatible storage holds screenshots, difference masks, sanitized DOM/context snapshots, and export manifests; database records contain references and hashes. The entities below are the application schema.

| Entity | Essential fields / relationships |
|---|---|
| `Workspace`, `Membership` | Tenant, roles, quotas, billing policy; every other record carries `workspace_id`. |
| `Project` | Application name, allowed origins, expected product behavior, default environment. |
| `EnvironmentVersion` | Immutable version, base URL, nonsecret settings, secret references, auth recipe, fixture recipe, target policy. |
| `SecretReference` | Vault identifier, variable name, description, scope, version, expiry; never raw value in session payload. |
| `Session` | Conversation container, creator, title, archive status, current run, pending access requests. |
| `Run` | Session, required target URL, optional target revision, immutable provider/config/scope/knowledge snapshot, lifecycle, outcome, limits, timestamps. |
| `RunContextAmendment` | Run, prior/new context revision, user-authorized scope or credential change, affected tasks, timestamp; preserves the original snapshot. |
| `Message` | Session, author, structured blocks, parent/related entity, timestamp, visibility; no hidden model reasoning. |
| `AgentTask` | Run, role, parent task, case/finding reference, state, priority, dependency IDs, queue reason. |
| `Attempt` | Task, attempt number, lease/fencing token, worker/context, start/end, failure class, evidence index. |
| `GoalHypothesisVersion` | Inferred goal, source observations, alternative interpretations, confidence rationale, user correction, current applicability. |
| `Flow` | Goal version, entry state, ordered/branching transitions, role/viewport/data conditions, importance/risk/novelty scores, frontier and stopping reason. |
| `ObservedState` | Run/context, URL, semantic route and UI state, role/auth context version, viewport, DOM fingerprint, screenshot/context references, observed timestamp. |
| `ActionAttempt` | Action ID, flow/state/task/attempt IDs, parent/retry ID, typed target/action, pre-dispatch prediction ID, dispatch/result timestamps, result class, usage references. |
| `ActionPrediction` | Expected state/change, assertion criteria, intent provenance (`inferred`, `user`, `spec`, `ui_contract`, `invariant`), source evidence, uncertainty, predictor model/prompt version. |
| `ActionAssessment` | Action ID, before/after capture IDs, diff/context references, independent change class / expectation-match / execution-outcome dimensions, reasoning, criterion outcome, uncertainty, evaluator version. |
| `StateTransition` | Before/after state IDs, action ID, flow ID, observation status; retains no-change loops and errors without pretending they are novel states. |
| `TestCaseVersion` | Stable case ID, immutable version, flow/goal origin, behavior key, preconditions, outline, acceptance criteria and intent provenance, viewport/role/data conditions. |
| `CaseExecution` | Run, case version, task, execution state, latest settled verdict reference. |
| `Verdict` | Attempt, verified/issues_found/blocked, criterion-level results, coverage gaps, supporting evidence, evaluator version. |
| `Finding` | Kind (functional/static), title, expected/actual, expectation justification, uncertainty, severity, state, source action/case/attempt, candidate fingerprint, canonical duplicate ID. |
| `Reproduction` | Finding, independent attempt, clean-start metadata, reproduced/not_reproduced/inconclusive, evidence and reason. |
| `ScreenshotCapture` | Unique `capture_id` per occurrence, action/phase (before, after, transient), state/context IDs, object key/hash, dimensions/viewport, capture timestamp, redaction metadata or explicit capture failure. |
| `Artifact` | Object key, tenant, run/flow/action/attempt, type/source class, hash, schema/tool version, capture time, URL/viewport metadata, retention policy version, redaction state, training eligibility. |
| `TriageDecision` | Finding, disposition, reason, actor, timestamp, optional duplicate/knowledge reference; append-only. |
| `AccessRequest` | Missing capability, affected tasks, requested input schema, status, resolution reference. |
| `KnowledgeEntryVersion` | Reviewed text, scope, provenance, review status, version, expiry. |
| `UsageEntry` | Workspace/user/provider-connection/run/flow/action/task/attempt/provider-call IDs, usage kind, reported/estimated units, rate version, cost or unavailable reason, provider request ID, recorded timestamp. |
| `ProviderCall` | Provider/model/adapter/auth mode, prompt template/version and sanitized input references, parameters, tool/result references, latency, status/error/retry, token/usage provenance. |
| `BudgetReservation` | Run, operation/attempt, reserved amount, dimension, enforcement mode (enforceable bound or estimate), expiry, settled/released status. |
| `Schedule`, `ScheduleOccurrence` | URL, optional goals/config, cron/time zone, overlap rule, unique scheduled instant, resulting session, launch status. |
| `RunEvent`, `OutboxEvent` | Ordered session sequence, entity/version, event type, sanitized payload, causation/idempotency keys. |
| `DatasetExample`, `DatasetManifest` | Explicit training/evaluation eligibility, source event/artifact IDs, human labels, source/target revision, collection/redaction/schema versions, split, export version, exclusion/deletion status. |

Never deduplicate only by title. A normalized key should include behavior, role, preconditions, meaningful input class, target area, viewport relevance, and expected outcome. Similarity search can suggest merges; a deterministic check or reviewed coordinator decision must preserve materially distinct cases. Keep aliases and provenance when merging. Findings need a separate deduplication key based on observed defect, affected behavior, and conditions; cosmetic wording changes should not create a new issue.

### Observability and training lineage

Use the same identifier values across PostgreSQL, ClickHouse, object storage manifests, and model/tool telemetry: `workspace_id → session_id → run_id → flow_id → state_id/action_id → task_id/attempt_id`, with `model_request_id`, `capture_id`, `artifact_id`, `event_id`, and causal parent IDs. Database and artifact schemas use snake_case. The proposed JSON API uses camelCase aliases: `captureId` maps to `capture_id`, `beforeCaptureId` to `before_capture_id`, `afterCaptureId` to `after_capture_id`, `diffMaskArtifactId` to `diff_artifact_id`, `checkId` to `check_id`, and `providerCallId` to `model_request_id`; these are the same identities, not new records. Every wait, retry, no-change step, network failure, screenshot failure, and cancelled operation emits an outcome, not only successful interactions. Usage absent from a subscription runner is marked unavailable; it is never silently converted to zero tokens or zero cost.

Attribute usage to the initiating user and provider connection as well as the run. Preserve provider input/output totals and cache/reasoning subcategories without adding a subset to its parent total twice. Keep provider-reported usage, estimated API currency cost, settled charges, and subscription entitlement consumption distinct. A provider route without enforceable output limits supports estimated admission plus call/time/concurrency limits, not a guaranteed dollar ceiling; record that capability and disclose it in the UI. See [model connections and accounting](../platform/models.md).

An outbox consumer sends immutable events to ClickHouse. Assume duplicate delivery: event IDs and versions support deduplicated queries; corrections append a superseding event rather than rewriting history. Track ingestion lag and dead letters so a missing analytical event is detectable. Authoritative UI mutations and final reports continue to use PostgreSQL while ClickHouse catches up.

A future training example should link its pre-action prediction, source goal and intent provenance, before/after screenshots, difference mask, DOM/network context, typed action, observed assessment, reproduction result, and human triage label. Store model/prompt/tool/schema versions, collection policy, redaction version, source revision, timestamps, permissions, and dataset split in a versioned manifest. Do not store hidden chain-of-thought. Do not treat an agent's own verdict as ground truth: retain label provenance and human review. Keep related attempts, duplicates, and application revisions within an appropriate dataset grouping to prevent train/evaluation leakage. Observability capture does not itself authorize model training; exports require the selected data's eligibility and exclude credentials and restricted content.

Archive the seven user-supplied design-reference screenshots with `purpose: design_reference` and `training_status: excluded_reference` in the archive manifest. They are product research material, not observations made by our browser runner. Keep their manifest and object prefix separate from `browser_observation` artifacts, and never synthesize action/state provenance for them. These archive fields map to the product artifact's source class and training eligibility; actual archive availability is recorded in [Local infrastructure](../platform/infrastructure.md).

## 5. State and correctness rules

### Independent state dimensions

- Task execution: `queued → running → succeeded | blocked | failed | cancelled`; a retry creates a new attempt, not a rewritten execution history.
- Case verdict: `unverified | verified | issues_found | blocked`. Queue/running is an execution property, never a verdict.
- Functional finding: `suspected → reproducing → confirmed | not_reproduced | inconclusive`. Triage is a separate dimension.
- Static finding: `flagged`, with screenshot evidence and a clear indication that no independent functional reproduction occurred.
- Run lifecycle: `created → planning → active → settling → completed`, with `stopping`, `cancelled`, and `failed` branches. Attention status is independent: `none | needs_input | budget_limited`.
- Completed run outcome: `clean | findings | incomplete`. Stop and infrastructure failure do not masquerade as a clean result.

### Required invariants

1. A confirmed functional bug references a successful independent reproduction attempt with a distinct browser context and fresh preconditions, plus a justified expected behavior. User requirements, a reliable spec, an unambiguous UI contract, or a demonstrable invariant can justify it. Inferred user intent alone cannot. A retry of the original observer's step is not independent reproduction.
2. A verified criterion references captured evidence or a deterministic observation. A missing element can be a selector failure; it is not automatically a product defect.
3. Blocked setup, browser crashes, model errors, navigation errors, and quota exhaustion retain their failure class. Reclassify only with supporting evidence.
4. The final report cannot claim completion while tasks, pending reproductions, or mandatory criteria remain unsettled. Report denominator and exclusions explicitly; no implied “percentage of the entire app.”
5. At-least-once task delivery produces one logical result: idempotency keys, leases, and a fencing token reject late commits from a replaced worker.
6. A clean browser does not imply clean backend data. Allocate a separate test account/fixture namespace per mutable flow, or lock shared resources.
7. Cancellation prevents new admission, signals all tasks, tears down browser contexts, releases unused reservations, and records unverified coverage. Preserve pending-settlement reservations for work already dispatched. The UI shows “Stopping” until resources acknowledge termination; late usage settlement can continue without reviving the run.
8. A reproduction against a different deployment revision is inconclusive for the original revision unless the change is explicitly a recheck.
9. Cost counts actual work and provider usage, not just elapsed session time. Reservations include concurrent in-flight calls and an allowed settlement margin; a displayed hard ceiling needs enforceable bounds at every charged provider and local admission enforcement. Without those capabilities, label cost limits as estimates and enforce call/time/concurrency limits instead. Cancellation cannot guarantee zero subsequent settlement.
10. Every dispatched action has a persisted pre-action prediction, unique before/after capture records or explicit capture failures, a context/difference record, and an assessment. No-change, minimal-change, waits, and errors remain queryable.
11. A difference mask alone cannot confirm a defect. Dynamic content, loading state, expected inactivity, relevant DOM/network changes, and capture reliability must be considered.
12. PostgreSQL is authoritative for actions and run state. ClickHouse ingestion delay or an analytics outage cannot manufacture task completion or permit an over-budget action.
13. An auth request never triggers a purchase, payment, subscription, or wallet operation. Missing access pauses dependent work while independent flows continue.

## 6. Proposed external API and event contract

All routes are workspace-authorized. Mutations accept `Idempotency-Key`. Return structured errors (`code`, `message`, `retryable`, `affectedEntityIds`); never expose a raw provider error containing credentials. Configuration is validated and snapshotted when a run starts.

| Method / endpoint | Purpose and essential response |
|---|---|
| `POST /v1/sessions` | Required `url`; optional goals/settings/environment/provider → `sessionId`, `runId`, `snapshotVersion`, `eventsUrl`. Defaults permit URL-only discovery. |
| `GET /v1/sessions/:id` | Snapshot, summary counts, lifecycle/outcome, attention, spend/reservations, last sequence. |
| `POST /v1/sessions/:id/messages` | Steering message or reply → accepted message ID and scope revision; acceptance is not execution completion. |
| `GET /v1/sessions/:id/events?after=...` | SSE, ordered replay from cursor with heartbeat. |
| `GET /v1/runs/:id/tasks` | Cursor pagination, role/status filter, authoritative totals. |
| `GET /v1/runs/:id/graph` | Goal hypotheses, flow/state/action edges, frontier priorities, visited and blocked branches. |
| `GET /v1/actions/:id` | Pre-action prediction, before/after capture IDs, diff/context evidence, assessment, attempts, usage, lineage. |
| `GET /v1/runs/:id/cases` | Cases, execution status, verdict filter, authoritative totals. |
| `GET /v1/runs/:id/findings` | Kind/verification/triage filters; suspected records are distinct from confirmed. |
| `GET /v1/attempts/:id` | Scoped transcript and screenshot timeline, every action/wait/error, evidence metadata. |
| `POST /v1/runs/:id/cancel` | Full-run cancellation → operation ID; idempotent. |
| `POST /v1/runs/:id/recheck` | Case/finding IDs and target revision → new run ID. |
| `POST /v1/access-requests/:id/resolve` | Secret reference or factual answer → resolution ID and resumable tasks. |
| `POST /v1/findings/:id/triage` | Disposition/reason/duplicate ID → decision ID; optional knowledge draft. |
| `POST /v1/knowledge/drafts/:id/accept` | Reviewed scope/text → new knowledge version. |
| `GET /v1/runs/:id/report` | JSON/Markdown manifest, snapshot version, incomplete marker, signed artifact links. |
| `GET /v1/artifacts/:id/access` | Short-lived scoped download/view grant; no public permanent bucket URL. |
| `POST /v1/environments` | Versioned environment and secret references; write-only secret inputs use a separate vault-backed route. |
| `POST /v1/schedules` | URL, optional goals/config, cron, IANA time zone, overlap policy → schedule and next occurrences. |

Example SSE payload (our design):

```json
{
  "schemaVersion": 1,
  "eventId": "evt_01...",
  "sessionId": "ses_01...",
  "runId": "run_01...",
  "sequence": 184,
  "type": "action.assessed",
  "occurredAt": "2026-10-14T20:30:00.000Z",
  "entity": { "type": "action", "id": "act_01...", "version": 3 },
  "payload": {
    "flowId": "flow_search",
    "attemptId": "att_observe",
    "beforeStateId": "state_14",
    "afterStateId": "state_15",
    "predictionId": "pred_01...",
    "beforeCaptureId": "cap_01...",
    "afterCaptureId": "cap_02...",
    "checkId": "check_01...",
    "diffMaskArtifactId": "art_diff_01...",
    "contextArtifactId": "art_context_01...",
    "changeClass": "minimal_change",
    "expectationMatch": "inconclusive",
    "executionOutcome": "succeeded",
    "intentSource": "inferred",
    "findingStatus": "candidate"
  }
}
```

Minimum events: `message.created`, `goal.inferred`, `goal.revised`, `flow.discovered`, `flow.prioritized`, `state.observed`, `task.queued`, `task.started`, `task.progress`, `task.settled`, `action.predicted`, `action.dispatched`, `screenshot.captured`, `screenshot.failed`, `action.assessed`, `action.failed`, `provider_call.settled`, `case.created`, `case.verdict_recorded`, `finding.suspected`, `finding.confirmed`, `finding.flagged`, `finding.triaged`, `access.requested`, `access.resolved`, `usage.recorded`, `budget.threshold_reached`, `run.stopping`, `run.completed`, `run.cancelled`, `run.failed`.

Commit state and its outbox event in the same transaction. Give events a monotonic per-session sequence; do not assume worker clocks are ordered. The client deduplicates by event ID, applies only newer entity versions, and reconnects from the last durable sequence. Expired cursors return a resync instruction and snapshot, not silent data loss. Load the initial snapshot and continue after its sequence to avoid a subscription race. Send screenshot and diff references through events, not image bytes. The UI fetches artifacts by authenticated short-lived grants. Fan out committed events independently to the UI and ClickHouse; neither consumer controls transactional truth.

## 7. Phases, tickets, and acceptance criteria

Implement incremental working milestones. Advance only when each acceptance test passes on real browser interactions; measure elapsed work and remaining risk after the milestone instead of promising a calendar date. Keep the first implementation local. Hosted operations and broad arbitrary-site reliability are separate readiness gates.

| Phase / ticket | Work and dependency | Acceptance criterion |
|---|---|---|
| M0 · SPEC-01 | Freeze state, action-prediction, graph, evidence, and provider schemas | Reviewers distinguish inferred expectations, reproduced observations, justified defects, blocked work, and infrastructure errors. |
| M0 · INFRA-01 | Local PostgreSQL, ClickHouse, S3-compatible `qa-evidence` bucket, reference archive | Start dependencies, read back byte-identical reference images by unique capture ID, verify restart persistence; record measured status in the infrastructure document. This does not establish a working browser engine. |
| M0 · EVAL-01 | Controlled apps with known defects, valid no-change actions, intended oddities, expired auth, and intermittent failures | Each fixture has an expected result and reset procedure; the agent receives only the URL for discovery tests. |
| M1 · DEV-01 | Extend Compose with Rust/Axum API, TypeScript/Playwright worker, and just commands; reuse PostgreSQL task leases, ClickHouse, and S3-compatible storage | One documented command starts the complete local runtime; restart preserves a sample browser run and its evidence. |
| M1 · CORE-01 | Session/run/graph/action/attempt schema and immutable configuration | Every operation joins to its run and context revision; foreign keys reject orphan evidence references. |
| M1 · MODEL-01 | Claude/OpenAI BYO API adapters and explicit capability detection | A real authorized provider call returns structured action intent; secrets stay out of logs; unsupported capabilities fail clearly. |
| M1 · EXEC-01 | Predict → before capture → action → after capture/diff/context → assess | One real action completes the full loop; identical images still have distinct capture IDs; absent capture yields an explicit error. |
| M1 · OBS-01 | PostgreSQL outbox to append-only ClickHouse with artifact lineage | Success, wait, no-change, timeout, retry, and failed model calls are queryable by shared IDs; duplicate ingestion does not inflate reports. |
| M2 · GRAPH-01 | URL-only goal inference and prioritized flow graph | A URL alone produces provisional goals and meaningful branches; novel/high-value paths outrank repeated low-value loops under the configured budget. |
| M2 · AGENT-01 | Case executor and combined visual/DOM/network checks | Correct inactivity passes, a small meaningful error is detected, animation alone is not declared a bug, and failures retain their class. |
| M2 · UI-01 | Session/transcript/tabs plus graph and screenshot/difference viewer | Reviewers can navigate prediction→action→outcome for every attempt; refresh/reconnect preserves counts and evidence. |
| M2 · AUTH-01 | Credentials, user-driven account creation, access requests | Login/paywall blocks dependent flows; public work continues; no purchase/subscription/payment/wallet action occurs. |
| M3 · VERIFY-01 | Independent reproduction and justified-intent gate | Reproduced but ambiguous behavior remains a candidate; only independently reproduced and justified functional defects become confirmed. |
| M3 · REPORT-01 | JSON/Markdown report and screenshot evidence manifest | Every case/flow has an outcome or gap; inferred criteria and missing artifacts are visible; no implicit whole-app pass. |
| M3 · REVIEW-01 | Human triage, duplicate linkage, dataset eligibility and label provenance | Decisions are auditable; repeated candidates do not inflate counts; dataset examples retain provenance and require eligibility. |
| M4 · EXEC-02 | Bounded parallelism, leases, recovery, cancellation | Configured cap survives worker crashes; late workers cannot commit stale results; stop prevents new dispatch and tears down contexts. |
| M4 · DATA-01 | Fixture allocation and shared-resource locking | Mutable flows cannot corrupt each other's test data; setup/teardown failures remain visible. |
| M4 · COST-01 | Usage ledger, reservations, spend/time/step limits and reproduction reserve | Concurrent calls cannot bypass admission; unavailable subscription usage remains unavailable; settlement preserves user/provider attribution; estimated caps are never represented as enforceable dollar ceilings. |
| M4 · MODEL-02 | Eligible local subscription mode / native runner validation | The chosen route authenticates through documented tooling, passes a real image/tool round trip, and rejects unsupported API capabilities; native runners remain optional. |
| M5 · KB-01 | Reviewed scoped knowledge and version pinning | Intended behavior guidance applies only to matching scope; unreviewed text cannot silently suppress findings. |
| M5 · RECHECK-01 | New-revision rechecks and comparisons | Original evidence remains intact; fixed/unfixed/inconclusive reflect new attempts and justified criteria. |
| M5 · SCHED-01 | Recurring URL sessions and run history | Time-zone/DST and duplicate delivery produce one occurrence; deleted selected environments fail visibly. |
| M5 · CLI-01 | Thin start/status/wait/report CLI using the same public API | Scripts start with a URL and follow a run without UI scraping; exit codes distinguish attention and failure. |
| Hosted gate · OPS-01 | Workspace authentication, tenant/network isolation, secret management, recovery, retention/redaction, audit | Access-control and failure tests pass before shared hosting; no fixed retention promise without an explicit policy choice. |
| Later · CI-01 | PR context, deployment revision verification and reusable tests | A report names the tested app/source revisions; generated tests require an actual successful replay. |

The first vertical slice is one URL, one inferred goal, and one real action with its prediction, paired captures, difference mask, context, assessment, and usage lineage. Expand to a graph of flows, then independent reproduction, then parallel execution. Hand-authored fixtures are for validation; they must not replace URL-only behavior in the user flow. All UI progress comes from persisted execution events.

## 8. Release gates and measurement

Use a repeatable benchmark before making quality claims. Start with at least 30 seeded functional defects, 20 clean/intended-behavior cases, and 10 access/infrastructure fixtures distributed across several controlled apps. Include responsive layout, sorting, navigation, validation, persistent state, login, and asynchronous UI cases. Reserve a held-out set for acceptance so prompts are not tuned only to the training fixtures.

Proposed beta gates, to validate rather than promise:

- At least 90% of reported confirmed functional bugs are accepted as real defects by blinded human review; publish sample size and uncertainty internally.
- At least 80% of seeded, in-scope defects are found at the chosen budget, measured separately from precision and reported with sample size.
- Every confirmed functional bug has an independent reproduction attempt and usable evidence; missing evidence downgrades the result.
- Every dispatched action references a prediction committed before dispatch and unique before/after captures or capture failures. Difference masks and context are available for every successful capture pair.
- URL-only tests discover likely flows without a brief; inferred goals stay labelled, and reproduced ambiguity is never promoted solely because the model expected another result.
- No-change/minimal-change fixtures are classified by expected behavior and context; animation and live-data movement alone do not become defects.
- Authentication and paywall fixtures request access while other work continues; they cannot trigger payment, subscription, purchase, or wallet operations.
- No access/infrastructure fixture is counted as a verified case or confirmed product defect without independent supporting observation.
- No session reports clean when a required case is blocked or unverified.
- Reconnecting UI reproduces the same report and totals; duplicated task/event delivery does not duplicate findings or spend entries.
- ClickHouse lag or outage leaves authoritative PostgreSQL state intact; later replay restores complete, deduplicated observability, including failed and cancelled attempts.
- The seven design-reference screenshots stay excluded from training and separate from browser observations; dataset manifests preserve source provenance and eligibility.
- Cancellation and budget tests measure the worst-case in-flight settlement tail. The UI states the enforcement semantics accurately.
- Standard staging benchmark reports p50/p95 time to first case, first confirmed finding, completed report, browser minutes, model tokens, and cost per accepted defect. Baseline numbers must be measured, not invented.

Track false positives by cause: misunderstood intent, unstable data, wrong element, transient rendering, stale knowledge, revision drift, and evidence loss. Track gaps by cause: unavailable auth, missing fixtures, unsupported browser behavior, budget, time, or agent failure. These categories should drive engineering work instead of treating more agents or more generated cases as quality improvements.

## 9. Decisions before implementation

Build the first local milestone with the documented defaults and record what is actually running in [local infrastructure](../platform/infrastructure.md). Validate provider account eligibility and tool/image compatibility through the paths in [model connections](../platform/models.md). Before shared hosting, settle deployment region, retention policy, target-network access, test-data isolation, and data-processing permissions. Record these decisions in versioned configuration, based on measured reliability and operating cost.

## Change log

Dated implementation notes, newest first. The status section above supersedes them.

28 October report increment: a selected run can now be exported as escaped Markdown, its existing JSON snapshot, or a portable ZIP with original PNGs and recorded JSON artifacts. A file manifest records size/hash verification and explicit evidence gaps. The export pins source data, keeps human decisions separate from model suspicion, references related runs without silently collecting their evidence, and does not approve data for training. See [portable reports](../runtime/reports.md). Versioned training datasets, sampling/splits and export approval remain future work.

28 October implementation update: [automatic reproduction](../exploration/automatic-reproduction.md) now schedules bounded fresh checks after an opted-in queued exploration completes. Durable reservations, manual/automatic deduplication, provider and evidence deferral, child lineage and independent batch cancellation are implemented. Automatic results preserve the source judgments and still require human review for confirmation. Dataset export, live-model quality evaluation, spend quotas, resume and multiple workers remain future work.

Implementation update: [human finding review](../exploration/finding-reviews.md) adds append-only confirmation, dismissal and reopening, tied to independently reproduced and hash-verified evidence. The original model judgments and fixture training exclusions remain preserved.

26 October implementation update: [durable run cancellation](../exploration/cancellation.md) now stops queued jobs, active exploration and reproduction, including private login. Screenshots and model usage remain available; dispatch checks and restart recovery prevent new actions after cancellation. Resume, multiple workers, live-model quality evaluation and reviewed bug confirmation remain pending.

25 October implementation update: [action completion and safe form journeys](../exploration/action-outcomes.md) now add bounded stability checks, retained screenshot samples, request/console diagnostics, native validation and permitted submission to exploration and reproduction. Live-model evaluation remains unverified.

24 October implementation update: [private app login and encrypted session reuse](../exploration/private-login.md) now support the local queued worker, including optional sign-in, authentication-context resets, authenticated replay and access interruption recovery. Google/external identity providers, parallel public exploration during a handoff and hosted secret management remain pending. Earlier milestone descriptions below are historical/planned scope.

Implementation update, 23 October: the local workspace, operations console, durable jobs, model gateway, exact evidence recorder and bounded explorer are working. The [exploration planner](../exploration/planner.md) now implements scored frontier selection, branch return, stale-plan recovery, a recorded discovery tree and three responsive viewport profiles. Fresh reproduction preserves return paths and source geometry. Broader requirements below remain a product specification; model scores have not been calibrated and test validation uses simulated providers.

The [browser interaction contract](../exploration/interactions.md) now also supports native text/search entry, single-select dropdowns, checkbox/radio changes and document scrolling. Typed values and scroll targets are recorded and preserved in reproduction. Permitted form submission and private native login have since been added; keyboard shortcuts and custom widgets remain pending.
