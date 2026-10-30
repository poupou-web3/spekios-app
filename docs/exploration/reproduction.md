# Recheck a suspected bug

The `reproduce` command replays a suspected explorer action and its preceding path in a fresh Chromium process and browser context. It preserves the original expected results and makes a separate model assessment after every action. Each attempt has new run, agent, worker, action, prediction and capture IDs, linked to its source. Original screenshots, actions and assessments remain unchanged.

## Run it

Start the stack with `just dev`. Configure a model and an allowed controlled-app origin as described in [URL exploration](./overview.md), then:

```sh
.tools/bin/just explore http://exploration-fixture:8082/broken-session
.tools/bin/just run RUN_UUID
.tools/bin/just reproduce SUSPECT_ACTION_UUID
.tools/bin/just run REPLAY_RUN_UUID
.tools/bin/just usage
```

Replace the placeholders with the returned IDs. Select an action whose assessment is `suspect` from the original run report. The source run must have finished, its evidence must be complete, and its expected result must not be marked uncertain. Deterministic recorder demos and replays themselves are not eligible sources. The current origin allowlist still applies.

There is **one verification attempt per source action**. Repeating the command returns the same attempt with `reused: true`; it starts no browser and makes no new model requests. An interrupted attempt remains inconclusive. Use `just recover REPLAY_RUN_UUID` and `just flush` to recover evidence and telemetry. Recovery never repeats browser actions. A new exploration run can produce a new candidate for another verification attempt.

## What the result means

| Outcome | Evidence |
| --- | --- |
| `reproduced` | Every step reached matching preconditions; a fresh assessment found the frozen expectation unmet, and the final observed state matches the original suspect action. |
| `not_reproduced` | The path completed and the fresh assessment observed no violation of the original expectation. An intermittent issue may still exist. |
| `inconclusive` | Preconditions changed, an earlier step was suspect, evidence or inference failed, the expectation was uncertain, or the final failure state differed. |

All outcomes retain `confirmed_bug: false`. A separate observation does not establish that the inferred expectation is a valid product requirement. The configured model may be the same model used for exploration, so the assessments can share a mistaken assumption. [Human review](./finding-reviews.md) can confirm or dismiss the candidate using a separate versioned decision.

## Automatic checks

Enable **Automatically recheck suspected bugs** in the workspace URL form to schedule replays after that queued original exploration completes. The option defaults to false. The worker selects eligible suspects in recorded action order, reserves their full replay paths, and creates separate child reproduction jobs. The default limit is two cases and twelve additional replay actions in total; operator settings allow one to three cases and one to twenty-four total actions. Each individual replay still has the twelve-action limit described below. CLI exploration does not participate in automatic scheduling because it has no parent browser job.

Automatic checks use the source job's provider/model settings and execution mode, the source viewport, and the exact saved authentication context when one was used. Existing manual jobs or attempts prevent another automatic attempt for the same source action. Admission of an already queued or running reproduction returns the existing job. Automatic children cannot schedule their own children, and cancelled or interrupted attempts are not retried automatically. A reservation is not released for another case when its replay is cancelled, invalidated or finishes early.

The source run's **Automatic checks** panel shows pending reservations, skipped cases, child jobs and reproduction outcomes. Temporary provider, queue or evidence-storage unavailability defers dispatch. Invalid paths, incomplete evidence structure, removed scope, unavailable saved sessions, completed human reviews and exhausted budgets can skip a case. **Stop automatic checks** stops the entire batch, including future planning and existing children, even after the original exploration has completed. It retains existing evidence and usage. See [automatic reproduction](./automatic-reproduction.md) for the full contract.

Before any new action, the recorder reads back the source screenshots and metadata and verifies their hashes and identity. Each fresh before-state must match the corresponding source image, URL, text, controls, viewport and scroll position exactly. A mismatch stops that step before dispatch. Timestamps are excluded from state identity. Every replayed prerequisite must receive `no_issue_observed` before the next step can run.

The assessor receives fresh before/after screenshots, the original frozen expectation, fresh recent history and pixel-difference statistics. It does not receive the original verdict or its reasoning. Exact masks still preserve one-pixel changes, and zero-change actions still require assessment. Video recording remains disabled.

## Evidence and usage

PostgreSQL stores the reproduction UUID, source run/action, new run, frozen path and result. The authenticated `GET /v1/runs/{id}` report includes `reproductions` for both source and replay. The new immutable bucket manifest includes this relationship; the original manifest remains its historical snapshot. Capture occurrences always receive new UUIDs, although identical PNG bytes may share a blob.

For automatic checks, the live report also includes `automatic_reproductions` with reservation, child-job and outcome links. Scheduler decisions and cancellation events are appended to PostgreSQL and exported to ClickHouse. These later records appear as live report overlays; they do not rewrite the original immutable manifest or its original AI verdicts.

`reproduction.started`, `reproduction.completed` and interruption events export through the existing outbox to ClickHouse. Model requests/responses, screenshots, masks and usage use the same durable evidence pipeline as exploration. Replay makes at most one assessment request per recorded action, with 2,048 output tokens and one provider attempt per request. Original prediction requests are referenced, not executed or charged again. The replay has its own usage totals; `just usage` includes both original and replay calls. Unknown usage remains unknown.

Source fixture exclusions carry forward, and simulated-provider or bundled-fixture runs are always `excluded_fixture`. Other controlled-app evidence remains `unreviewed`; reproduction does not automatically make data eligible for training.

## Verification and limits

Run `just explorer-test` for the exploration and reproduction integration suite. It temporarily uses fake providers with real Chromium, PostgreSQL, S3 and ClickHouse, then restores normal provider configuration. Tests cover persistent failure, repaired behavior, a different failure, changed prerequisites, fresh cookies/local storage, invalid sources, idempotent reuse and interruption recovery. The CLI/API check also verifies immutable object hashes, source preservation, token totals and ClickHouse events. Its report is saved to [artifacts/reproduction/verification.json](../../artifacts/reproduction/verification.json).

Run `just auto-reproduction-test` for the automatic scheduler and queued-worker integration suite. It uses real Chromium and storage services with simulated models and restores ordinary provider configuration afterward. This command does not establish live-model QA quality or GUI layout correctness; those remain unverified.

This version replays at most twelve executed actions using the explorer's [typed interaction contract](./interactions.md) and the source run's desktop/tablet/mobile viewport. It preserves fill/option values, checkbox/radio booleans, document scroll targets and recorded returns to the original entry URL. Up to three skipped stale plans can appear in the source history; they are not dispatched again. Dynamic screens can fail the exact-state check. Fresh browser storage does not reset server data, establish an equivalent backend state or isolate workers from a hostile site. Use the same operator-controlled apps supported by the current explorer. Live-model accuracy, external identity-provider handoff and multiple verification attempts remain unfinished.

Authenticated paths use the exact saved app session and replay only the segment in that authentication context. Private login actions are excluded. Expired, removed or unsaved sessions require a new signed-in run; see [app login](./private-login.md).
