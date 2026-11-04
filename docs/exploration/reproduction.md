# Recheck a suspected bug

The `reproduce` command replays a suspected explorer action and its preceding path in a fresh Chromium process and browser context. It preserves the original expected results and makes a separate model assessment after every action. Each attempt has new run, agent, worker, action, prediction and capture IDs, linked to its source. Original screenshots, actions and assessments remain unchanged.

## Run it

Start the stack with `just dev`. Configure a model as described in [URL exploration](./overview.md), then:

```sh
just explore http://exploration-fixture:8082/broken-session
just run RUN_UUID
just reproduce SUSPECT_ACTION_UUID
just run REPLAY_RUN_UUID
just usage
```

Replace the placeholders with the returned IDs. Select an action whose assessment is `suspect` from the original run report. The source run must have finished, its evidence must be complete, and its expected result must not be marked uncertain. Deterministic recorder demos and replays themselves are not eligible sources.

There is **one verification attempt per source action**. Repeating the command returns the same attempt with `reused: true`; it starts no browser and makes no new model requests. An interrupted attempt remains inconclusive. Use `just recover REPLAY_RUN_UUID` and `just flush` to recover evidence and telemetry. Recovery never repeats browser actions. A new exploration run can produce a new candidate for another verification attempt.

## What the result means

| Outcome | Evidence |
| --- | --- |
| `reproduced` | Every step reached matching preconditions; a fresh assessment found the frozen expectation unmet, and the final observed state matches the original suspect action. |
| `not_reproduced` | The path completed and the fresh assessment observed no violation of the original expectation. An intermittent issue may still exist. |
| `inconclusive` | Preconditions changed, an earlier step was suspect, evidence or inference failed, the expectation was uncertain, or the final failure state differed. |

All outcomes retain `confirmed_bug: false`. A separate observation does not establish that the inferred expectation is a valid product requirement. The configured model may be the same model used for exploration, so the assessments can share a mistaken assumption. [Human review](./finding-reviews.md) can confirm or dismiss the candidate using a separate versioned decision.

Queued explorations can also schedule these replays automatically after they complete; see [automatic rechecks](./automatic-reproduction.md).

## How a replay runs

Before any new action, the recorder reads back the source screenshots and metadata and verifies their hashes and identity. Each fresh before-state must match the recorded route, control set and visible text, using the same comparison as candidate fix verification. Clock and date labels may differ, and scroll within 8 pixels still matches. Screenshot bytes stay stored and are masked exactly. A change to the page itself stops that step before dispatch. Every replayed prerequisite must receive `no_issue_observed` before the next step can run.

The assessor receives fresh before/after screenshots, the original frozen expectation, fresh recent history and pixel-difference statistics. It does not receive the original verdict or its reasoning. Exact masks still preserve one-pixel changes, and zero-change actions still require assessment. Video recording remains disabled.

## Evidence and usage

PostgreSQL stores the reproduction UUID, source run/action, new run, frozen path and result. The authenticated `GET /v1/runs/{id}` report includes `reproductions` for both source and replay. The new immutable bucket manifest includes this relationship; the original manifest remains its historical snapshot. Capture occurrences always receive new UUIDs, although identical PNG bytes may share a blob.

`reproduction.started`, `reproduction.completed` and interruption events export through the existing outbox to ClickHouse. Model requests/responses, screenshots, masks and usage use the same durable evidence pipeline as exploration. Replay makes at most one assessment request per recorded action, with up to 4,096 output tokens and one provider attempt per request. Original prediction requests are referenced, not executed or charged again. The replay has its own usage totals; `just usage` includes both original and replay calls. Unknown usage remains unknown.

Source fixture exclusions carry forward, and simulated-provider or bundled-fixture runs are always `excluded_fixture`. Other target evidence remains `unreviewed`; reproduction does not automatically make data eligible for training.

## Limits

A replay runs at most 50 executed actions using the explorer's [typed interaction contract](./interactions.md) and the source run's desktop/tablet/mobile viewport. It preserves fill/option values, checkbox/radio booleans, document scroll targets, scrolls that revealed a lower control, recorded returns to the original entry URL and recorded resumes of a same-origin page remembered from earlier runs. Replays never read or write [app memory](./planner.md#memory-across-runs). Up to three skipped stale plans can appear in the source history; they are not dispatched again. Clock labels and screenshot pixels can differ on an otherwise matching page. A change to the route, controls or other visible text still stops the step. Fresh browser storage does not reset server data or establish an equivalent backend state. It runs in the same browser sandbox and accepts the same targets as the current explorer.

Authenticated paths use the exact saved app session and replay only the segment in that authentication context. Private login actions are excluded. Expired, removed or unsaved sessions require a new signed-in run; see [app login](./private-login.md).

## Tests

`just explorer-test` includes the reproduction integration cases (`test/reproduction.test.ts`) with simulated providers and real Chromium, PostgreSQL, S3 and ClickHouse: persistent failure, repaired behavior, a different failure, changed prerequisites, fresh cookies and local storage, invalid sources, idempotent reuse and interruption recovery. Its CLI check writes `artifacts/reproduction/verification.json`. `just auto-reproduction-test` covers [automatic rechecks](./automatic-reproduction.md).

## Not built yet

More than one verification attempt per source action, and live-model accuracy evaluation.
