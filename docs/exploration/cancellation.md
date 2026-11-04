# Stopping exploration

The workspace has **Stop run** on active explorations and **Cancel queued job** on waiting jobs. The back office's job list has the same controls. Stopping requires no additional confirmation. The UI shows **Stopping…** until the worker acknowledges the request; a worker that is offline acknowledges it during recovery.

Cancellation preserves recorded screenshots, frame IDs, graph nodes, comparisons, diagnostics and completed assessments. An unfinished action or assessment is inconclusive, never evidence of a product bug. It does not undo an action already sent to the target application. No action is automatically replayed or resumed.

## API and persistence

All endpoints require an authenticated caller and enforce workspace/user ownership:

| Endpoint | Result |
| --- | --- |
| `POST /v1/browser-jobs/:id/cancel` with `{}` | Cancels queued work immediately, or requests cancellation of a running job |
| `POST /v1/runs/:id/cancel` with `{}` | Requests cancellation of an active explorer or reproduction run, including a CLI explorer |
| `POST /v1/runs/:id/automatic-reproductions/cancel` with `{}` | Stops an opted-in source's pending and admitted automatic checks, including after exploration completes |

The response contains `cancellation_id`, `job_id`, `run_id`, `status` and `reused`. Pending cancellation returns HTTP 202 and `cancelling`. An acknowledged cancellation returns HTTP 200 and `cancelled`. Already terminal work returns HTTP 200 and `already_finished` without changing its outcome. Repeated requests through either endpoint reuse the same cancellation UUID. Unknown or foreign IDs return 404. Fixed deterministic recorder runs do not support active cancellation and return 409.

Migration `010-cancellation.sql` adds `cancel_id` and `cancel_requested_at` to jobs/runs and a cancelled state for actions, decisions and model requests. A queued cancellation creates no run, browser or model request; its job row retains the request UUID and timestamps. Run cancellation emits `run.cancel_requested`, followed by acknowledgement `run.cancelled`. These events use the existing PostgreSQL outbox and stable event IDs for ClickHouse export.

Stopping automatic checks uses its own batch cancellation ID and does not stop the source exploration; see [stop the batch](./automatic-reproduction.md#stop-the-batch).

## Worker behavior and races

Browser dispatch, new model decisions, gateway admission and provider dispatch check the durable request under the run-row lock. Final completion uses the same lock, so a cancellation that wins the race cannot silently become a completed run. Work admitted before the cancellation may already be in flight; the request is not a rollback of external side effects.

The explorer polls on a separate database connection every 200 ms and closes Chromium on cancellation, interrupting navigation and screenshot waits. The model client stops waiting without resubmitting. A private login handoff is released and its control lease invalidated; private screens and text remain excluded from evidence. New private-control operations also check the durable flag.

Evidence finalization and uploads can take longer than the polling interval. There is no hard acknowledgement deadline during a database or object-storage outage. Loss of run-control access stops further work. If the process dies, recovery preserves the cancellation and restores available evidence from the spool without re-executing browser actions.

## Provider usage

New model requests for a cancelled run are rejected with HTTP 409. Requests already queued at the gateway are checked again immediately before provider dispatch; cancelled requests have no new call/attempt. Re-submitting an existing logical request retains its original identity and result.

Calls already dispatched to OpenAI, Anthropic, OpenRouter or Meta AI are allowed to settle. Their raw response evidence and reported usage are retained even if the browser run has already stopped. Cancellation does not promise zero further charges, cancel a remote provider operation or convert unknown usage into zero. Reports in object storage are immutable snapshots; the live API shows later usage settlement.

## Tests

`just cancellation-test` (`scripts/test-cancellation.sh`) needs an idle local stack. It uses simulated providers with real Chromium, PostgreSQL, S3 and ClickHouse, restores normal provider configuration afterward, and writes `artifacts/cancellation/verification.json`. It covers authorization, queued cancellation and idempotency, interrupting slow navigation, cancellation during assessment, queued provider dispatch rejection and late usage, private-login lease invalidation, API restart and worker crash recovery, terminal-result protection, and ClickHouse delivery.

## Not built yet

Cancelling an operation already dispatched to a remote provider.
