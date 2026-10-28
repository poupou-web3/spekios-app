# Automatic fresh-browser checks

Automatic reproduction is an optional follow-up to a completed queued exploration. It selects eligible suspected bugs, reserves a bounded amount of work, and uses the existing [fresh-browser reproduction](./REPRODUCTION.md) pipeline to check each selected action and its prerequisite path. It does not confirm product defects or change [human finding review](./FINDING_REVIEWS.md).

## Start with a URL

In the workspace at **http://127.0.0.1:18080**, enter the application URL and optionally select **Automatically recheck suspected bugs**. No brief is required. The option defaults to false. An explicit choice is kept in the browser tab through refresh and URL changes; until then, the configured default applies. The launch help displays the additional case and action bounds when enabled.

The worker plans checks only after both the original exploration run and its parent browser job complete successfully. CLI exploration, failed or cancelled explorations, recorder demos and reproduction runs do not start an automatic batch. Each child is an ordinary durable reproduction job with automatic scheduling disabled, so replays cannot create recursive checks.

Operator defaults are configured in the private `.env` and applied with `just dev`:

```dotenv
SCOUT_AUTO_REPRODUCE=false
SCOUT_AUTO_REPRODUCE_MAX_CASES=2
SCOUT_AUTO_REPRODUCE_MAX_ACTIONS=12
```

Case limits range from one to three. The action limit ranges from one to twenty-four and covers the **sum of the entire selected replay paths**, including navigation and prerequisite actions. An individual replay remains limited to twelve executed actions. A case with a six-action path reserves six actions even if the suspected bug itself involves only the final click. These are browser-action limits, not token or monetary quotas; replay assessments use additional model calls with their own recorded usage.

Authenticated `POST /v1/browser-jobs` exploration requests accept the optional boolean `auto_reproduce`. The GUI always submits its explicit choice. Omission follows the operator default captured at admission. Clients cannot supply per-request case/action limits, and `reproduce` requests do not accept this flag. Existing request UUID idempotency still applies.

## Selection, reservations and dispatch

The scheduler examines suspects in recorded action order. A candidate must have a completed model assessment with a supported expectation, a valid source path, settled action outcomes and complete evidence. Every executed prerequisite must have received `no_issue_observed`; stale plans that were skipped before dispatch are not executed during replay. Source screenshots and immutable metadata are read back and verified before dispatch. Current allowed origins and any saved authentication context are checked again.

Eligible paths reserve a case and their full action count before a child is admitted. The reservation remains allocated if a check is later skipped, cancelled, interrupted or finishes early. Work is not recycled into another candidate. The scheduler creates at most one automatic child job per source action and does not retry cancelled or interrupted checks. A new exploration can create a new candidate with new evidence.

| Decision | Behavior |
| --- | --- |
| Provider or execution mode unavailable | Keep the reservation pending, or an admitted child queued, until the original connection can be used. |
| Temporary bucket/readback failure | Defer without dispatch; an admitted child keeps its job ID and waits before another evidence preflight. |
| Queue at capacity | Keep the reservation pending until capacity is available. |
| Invalid or incomplete path, unsupported assessment, corrupt or inconsistent evidence | Skip the candidate without browser dispatch. |
| Application no longer in allowed scope, missing/expired/revoked/unsaved authentication context | Skip the candidate. |
| Human already confirmed or dismissed the finding | Skip before dispatch. An already running check retains its own evidence and cannot overwrite the review. |
| Existing reproduction job or attempt | Do not create another automatic child. A manual submission for an already queued or running reproduction returns the existing job. |
| Case or total-action budget exhausted | Record a skipped candidate and its reason. |

These decisions are rechecked before a claimed automatic child allocates its run or calls a model. A storage deferral retries the preflight, not an executed browser trajectory. A single actual verification attempt remains the reproduction contract.

The child inherits the original job's provider/model settings and execution mode, the source desktop/tablet/mobile viewport, the recorded action parameters and the exact saved app session for that authentication context. It uses a new Chromium process and browser context. It does not repeat private login inputs, obtain credentials or switch to another provider to bypass a missing connection. Fresh browser storage does not reset server-side application data. Scope and controlled-app restrictions remain those of the current explorer.

## Inspect the checks

The source run's **Automatic checks** panel displays reservations, queue/storage/provider reasons, skipped cases, child status and reproduction outcomes. Each task links to its source action and any resulting replay run. Automatic child runs show their source lineage; Operations labels their jobs and parent relationship. A pending or active automatic task suppresses duplicate manual replay controls on the action.

The authenticated live run report exposes:

- `automatic_reproductions`: task IDs, source run/job/action IDs, decision status, reason, reserved `planned_actions`, child job linkage and any reproduction outcome.
- `run.config.automatic_reproduction_policy`: the frozen `enabled`, `max_cases` and `max_actions` values.
- `run.auto_reproduction_planned_at`, `run.auto_reproduction_cancel_id` and `run.auto_reproduction_cancelled_at`: durable planning and batch-stop state.

Task status describes the scheduling decision: `pending`, `queued` or `skipped`. A `queued` task may have a completed, cancelled or interrupted child; inspect `child_job.status` and `reproduction.result` for execution and assessment results. Tasks are included for both the source run and the corresponding automatic child run.

The source manifest remains an immutable historical snapshot. Later reservations, child jobs, cancellation state and reproduction outcomes are overlaid in the live PostgreSQL-backed report, rather than rewriting that manifest. New replay evidence has new run, action, capture and artifact IDs, linked to the original source. Scheduler events use the existing durable outbox to ClickHouse. Model request/response evidence, nullable token/cost reports, screenshots, masks and diagnostics use the ordinary evidence pipeline. Per-run usage remains attached to the run that incurred it; unknown usage stays unknown.

## Stop the batch

Select **Stop automatic checks** on the source run while planning or checks remain outstanding. It is available even after the source exploration completes, and can also prevent planning while the exploration is still active. It does not stop the original exploration or unrelated manual reproduction jobs.

Authenticated `POST /v1/runs/{source_run_id}/automatic-reproductions/cancel` with `{}` records the source stop flag, skips pending reservations, cancels queued children and records stop intent for existing active child runs in the same database transaction. Scheduler locking prevents new automatic admission from racing past that stop intent. The worker acknowledges active cancellation through the existing cancellation mechanism. Repeated requests reuse the saved batch cancellation ID. The response distinguishes `cancelling` from `cancelled`; the GUI retains the durable stop state and can retry an unacknowledged child stop request.

Completed replay outcomes remain unchanged. Existing screenshots, model evidence, actions and usage are retained. Stopping cannot undo browser actions or retract model calls already sent; usage may settle afterward. Cancellation and crash recovery never repeat the browser trajectory. Reservations remain allocated and the batch does not restart automatically.

## Results and verification

The existing `reproduced`, `not_reproduced` and `inconclusive` outcomes retain `confirmed_bug: false`. Reproduction checks whether observed behavior agrees with the frozen expectation; it does not prove that the expectation is a valid product requirement. Human confirmation still requires complete verified evidence, an expectation basis, severity and a separate versioned review. Automatic scheduling does not change training classifications: fixtures remain excluded and unreviewed real evidence remains unreviewed.

Run the dedicated suite while the local workspace is idle:

```sh
.tools/bin/just auto-reproduction-test
```

The command uses real Chromium, PostgreSQL, the private evidence bucket and ClickHouse with simulated model responses, then restores ordinary provider configuration. Verification on 28 October 2026 passed nine scheduler tests and seventeen queued-worker/API checks, including restart recovery, manual/automatic deduplication, viewport inheritance, immutable evidence, queued/active batch cancellation and ClickHouse export. The saved [integration record](./artifacts/automatic-reproduction/verification.json) contains the source and child IDs. Native API tests passed 23 cases, and pure frontend tests passed 19 cases through `just web-test`. Frontend tests do not launch a browser. GUI layout and live-model QA quality remain unverified.
