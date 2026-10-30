# Action completion and form journeys

Implemented 25 October 2026 (`action-completion-v1`, `browser-interactions-v2`). The URL explorer now waits for an observed action outcome before assessing it and selecting another branch. This also applies to fresh-browser reproduction.

## Completion evidence

After dispatch, the worker samples the viewport and a bounded DOM projection. It checks exact screenshot hashes, visible text and control state, URL changes, visible `aria-busy`/progress indicators, and requests started by this page during the action. It requires at least one second of observation and 600 ms of quiet, with no young tracked requests pending and no observed busy indicator. A connection still open after two seconds is treated as a background channel. A screenshot may use the time remaining in the window, so one slow frame can still be kept. Sampling is approximately every 200 ms, bounded to 24 frames and a five-second observation window. Dispatch, durable uploads and individual browser operations have their own timeouts, so this is not a five-second total wall-clock limit for the action.

Small pixel changes are preserved. CSS animation is held still while sampling, so a spinner does not by itself use up the deadline. A page that stays busy, or whose visible text keeps changing, can still reach the deadline; that action is assessed as **inconclusive**, and exploration stops with `action_completion_unresolved`. A change in the route or visible copy after the quiet sample also invalidates it. Screenshot pixels alone do not. Intermediate samples do not create exploration graph nodes. Before/after state identity uses the URL, controls and visible text.

This is bounded observation, not proof that all asynchronous work is finished. Delayed work beginning after the observation window, unmarked spinners, unobserved DOM content and background polling can still require application-specific completion signals. Existing stale-plan checks remain active before the next action.

Every retained sample has a unique `frame_id`, timestamp, originating action ID and bucket artifact reference. Identical PNG bytes share a content-addressed blob; occurrences retain distinct frame IDs. `action.settling_frame` events persist each association as sampling proceeds. The full sequence is also stored in an `action_completion` JSON artifact. Before/after captures keep their existing capture IDs and difference masks. No continuous video is recorded.

## Diagnostics

Each dispatched action collects bounded request start/response/finish/failure events plus console warnings/errors and uncaught page errors. Request UUIDs join lifecycle events; all events have UUIDs and action-relative times. They are stored in an `action_diagnostics` JSON artifact, summarized in `runtime_actions.outcome`, included in run manifests, and exported through the existing ClickHouse event outbox. HTTP response bodies, request bodies, headers, cookies, console argument objects and stack traces are not collected.

URLs omit queries, fragments and user information. Text filtering removes common secret patterns and email addresses, but is not a guarantee of redaction for arbitrary app-generated text. Logs remain private evidence for operator-controlled test apps. Collection is capped at 100 events per action; omitted event counts are explicit. Pending request tracking is bounded separately. Only requests started inside this action's collection window are attributed to it; pre-existing/background traffic is not reassigned to a later action.

The model receives a bounded diagnostic summary with artifact IDs and at most eight relevant errors. A failed request or console error is supporting evidence, never an automatic bug verdict. Unresolved completion, tool failure, or incomplete observations override the verdict to inconclusive. Final-capture failures retain earlier samples and diagnostics. Private login boundaries discard the active diagnostic window and prevent private screenshots from being archived; human-login input remains outside model observation.

## Form permissions

The model uses `{ "type": "submit" }` against an observed native submitter. A plain click cannot bypass submission permission. The worker clicks the actual native button, preserving constraint validation, submit events and submitter overrides; it never calls `form.submit()` to skip validation. Required-field validation messages are observed, and the agent may fill synthetic data and try again from the new state.

Two submission categories are supported:

- Same-origin GET search forms, identified by a search input or `role="search"`, with no detected sensitive/unsupported fields or risky action.
- Exact test forms explicitly allowed by the operator through `SCOUT_TEST_FORM_RULES`. Rules bind the full action URL, method and submitter's accessible name. No wildcards or page-provided permission attributes are accepted.

For a controlled test app, set this in the private `.env` and recreate the worker (for example, `docker compose up -d browser-worker`):

```dotenv
SCOUT_TEST_FORM_RULES='[{"action_url":"http://exploration-fixture:8082/journeys/draft-result","method":"post","submitter":"Save test draft"}]'
```

The target must already belong to `SCOUT_ALLOWED_ORIGINS`. The default rules are `[]`; no POST forms are enabled by default. The CLI and queued worker share this configuration. No new launch brief is required.

Sensitive fields, file uploads, credential/payment/destructive actions, off-origin destinations and new-window targets remain blocked even with a matching rule. Hidden fields participate in sensitive-field checks. The effective destination, method, target, field signature and permission are captured and checked again immediately before dispatch. A changed form contract fails closed. These are conservative heuristics for controlled apps, not proof that a GET handler is read-only or a browser script cannot perform a side effect.

Fresh reproduction retains the exact submission command and filled values, with the current operator rules still required. Replay does not reset backend data: permit write forms only in disposable test environments where repetition is appropriate.

## Workspace and operations

Open a recorded action and expand **Action completion** to see its wait outcome, request/error counts and sampled screenshot timeline. Clicking a timestamp shows that retained frame and its unique ID in the existing evidence viewer. **Inspect completion and diagnostics** shows the stored structured data. Operations includes settling frame counts, and its event view contains the same action-linked events.

Old runs without completion metadata continue to render normally. Screenshot occurrence counts include both before/after captures and settling frames; shared bucket blobs are not counted as separate storage copies.

## Verification

```sh
.tools/bin/just outcomes-test
.tools/bin/just explorer-test
.tools/bin/just web-test
.tools/bin/just web-contract-test
```

The controlled real-browser tests cover empty submission and native validation, delayed responses, dynamically exposed results, alternative branch exploration, HTTP 503/disconnect/console/page-error evidence, exact reproduction, configured POST permission, destination changes, persistent busy/animated pages, and a failed final screenshot. Existing authentication, recording and exploration suites cover regressions. Worker shutdown during collection is classified as interruption, with retained partial evidence and no action replay. Verified run IDs are saved in [artifacts/action-outcomes/verification.json](../../artifacts/action-outcomes/verification.json). Providers are simulated: this verifies execution/evidence behavior, not live-model QA accuracy. Live-model evaluation and visual GUI validation remain separate outstanding checks.
