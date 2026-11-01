# URL-driven exploration

Implemented on 22 October 2026 and extended on 23 October: a bounded browser loop connected to the Rust model gateway. It starts from a URL, ranks likely actions using the observed path and changed controls, returns to unexplored branches, replans stale decisions, and assesses both screenshots after every action. A run records its flow graph, selection reasons, predictions, assessments, model request IDs and token usage. See [the exploration algorithm](./planner.md) for scoring and routing. The integration suite uses **simulated model responses with real Chromium, PostgreSQL, S3 and ClickHouse**; it does not measure real-model QA quality.

## Run it

From the repository root:

```sh
.tools/bin/just dev
.tools/bin/just explorer-test
```

`explorer-test` temporarily puts the gateway in isolated provider-fixture mode, runs exploration/reproduction integration cases and CLI demonstrations, verifies bucket hashes and event export, then restores normal provider configuration. Real keys are ignored in fixture mode. Results are saved to [artifacts/explorer/verification.json](../../artifacts/explorer/verification.json) and [artifacts/reproduction/verification.json](../../artifacts/reproduction/verification.json). The controlled target remains available at `http://127.0.0.1:18082/branches` for inspection.

For live inference, add an optional provider API key to the private `.env`, as described in [model gateway](../platform/model-gateway.md). Choose the explorer configuration there once; a run itself needs only the URL.

The same loop is available from the [workspace](../platform/workspace.md) at **http://127.0.0.1:18080**. Submit the URL, follow the queued job, then inspect actions, screenshot masks, the flow graph and reproduction results. A background worker executes GUI jobs; the CLI remains available.

| Setting | Default | Meaning |
| --- | --- | --- |
| `SCOUT_EXPLORER_PROVIDER` | `openrouter` | `openai`, `anthropic`, `openrouter`, or `meta` |
| `SCOUT_EXPLORER_MODEL` | `openrouter/free` | Model ID. OpenRouter defaults to `openrouter/free`; Meta defaults to `muse-wonder-1.0` |
| `SCOUT_EXPLORER_FREE_ONLY` | `true` | OpenRouter free-route constraint; not applicable to direct OpenAI, Claude, or Meta billing |
| `SCOUT_EXPLORER_MAX_ACTIONS` | empty | Server default for users without saved limits; empty means no limit. Integer 1–10000; includes navigation, returns and resumes |
| `SCOUT_EXPLORER_MAX_MINUTES` | empty | Server default wall-clock limit per exploration attempt; empty means no limit. Integer 1–10080 |
| `SCOUT_EXPLORER_APP_MEMORY` | `true` | Default for remembering explored pages and controls across runs; see [memory across runs](./planner.md#memory-across-runs) |
| `SCOUT_EXPLORER_VIEWPORT` | `desktop` | `desktop` (800×600), `tablet` (768×1024), or `mobile` (390×844) |
| `SCOUT_ALLOWED_ORIGINS` | `http://exploration-fixture:8082` | Extra origins for private, HTTP and internal apps. Public https sites do not need an entry |
| `SCOUT_CHROMIUM_SANDBOX` | `true` | Chromium's own sandbox inside the browser sandbox container. Set `false` only on hosts where Chromium cannot start it |

```sh
.tools/bin/just dev
.tools/bin/just fixture
.tools/bin/just explore http://exploration-fixture:8082/branches
.tools/bin/just explore-matrix http://exploration-fixture:8082/responsive
.tools/bin/just runs
.tools/bin/just run RUN_UUID
.tools/bin/just graph RUN_UUID
.tools/bin/just usage
```

Replace `RUN_UUID` with the printed ID. The browser runs inside Compose: `exploration-fixture:8082` is the target's internal address; `127.0.0.1:18082` is its host preview address. A pasted public https site is accepted without being listed. Private, HTTP and internal apps need a reachable container address and that exact origin in `SCOUT_ALLOWED_ORIGINS`. No provider is configured automatically and subscription authentication is not implemented.

## Action and evidence contract

1. The model predicts the initial navigation, or ranks up to eight candidates from the current state's observed controls. Every candidate has a goal, likelihood and expected result. All model requests/responses pass through the existing durable gateway.
2. The selected prediction and action are committed before dispatch. Run, agent, worker, action, prediction, model decision and model request IDs establish lineage.
3. A fresh before screenshot is saved. It matches the planning observation on URL, controls and visible text. Clock and date labels share an identity, and scroll positions within 8 pixels do too. The PNG bytes are stored either way and still produce an exact difference mask. A change in that identity skips the stale action before dispatch, records a new state and change mask, and triggers replanning. Three skips terminate an unstable run.
4. The worker validates a typed interaction against an observed control, records dispatch, executes once, and saves the after screenshot. Supported actions include buttons/links, native text/search entry, dropdown selection, checkbox/radio changes and document scrolling. Models cannot supply JavaScript, selectors or new tools. See [browser interactions](./interactions.md) for exact parameters and limits.
5. Exact subtraction produces the binary mask and channel delta, including one-pixel changes. The original screenshots and derivatives are immutable bucket objects. Identical PNG bytes share a blob; each capture occurrence still gets a distinct UUID.
6. Before/after IDs, comparison and graph edge commit before assessment. The model receives both screenshots, bounded DOM observations, the frozen prediction, recent history and mask statistics/bounding box. The stored mask is available for inspection; it is not currently sent as a third model image.
7. A separate model call assesses every executed action, including a zero-change mask. Its result must reference the exact two captures. Tool/observation errors and unsupported expectations force `inconclusive`. Use `just reproduce ACTION_UUID` to check a suspect action in a fresh browser with separate evidence. [Reproduction outcomes](./reproduction.md) remain `confirmed_bug: false` pending review of the expectation and observations.

If a model assessment fails, available screenshots, masks and the executed edge remain recorded; no next action runs. Missing before evidence prevents dispatch. Model requests use stable UUIDs so a lost admission acknowledgement can be retried without creating another logical request. An interrupted model wait can still settle in the gateway; it cannot dispatch a dependent browser action after the explorer stops.

Screenshots and DOM reads are sequential observations with separate timestamps, not an atomic view of a dynamic application. Before/after sampling does not capture every intermediate animation frame. During capture the page clock is paused, CSS animations are held on their initial frame, reduced motion is requested, and the caret is hidden. The stored PNG is the exact device pixels of that frame. Continuous video is disabled.

## Flow graph and access blocks

PostgreSQL stores states, action edges, a frontier of observed controls, and model decisions. The authenticated Rust API exposes `GET /v1/runs/{id}/graph`; the ordinary run report and immutable bucket manifest also include the graph. Runtime events export to ClickHouse, and model calls retain their separate request/response payloads and usage ledger.

State identity is the URL, visible text, controls, viewport, authentication context and an 8-pixel scroll bucket. Clock, date and relative-time labels fold into one value. Screenshot bytes stay on the capture as evidence and do not create another graph node. Previously attempted controls in the same state are not selected again. The planner ranks pending branches across known states, follows successful recorded routes or reopens the original URL, and verifies each return. Reopening the URL does not reset browser storage or server data. Unvisited and unreachable controls remain explicit. Pages whose text or controls keep changing can still create many states; action and replanning limits bound that growth. The discovery tree preserves first-parent ancestry while the graph retains cycles and return edges.

Ambiguous, disabled or covered controls, unapproved form submissions, links outside the entry site's registered domain, and recognizable credential, payment or destructive controls are recorded as blocked. Subdomains of that domain, such as `v2.bubblemaps.io` and `intel.bubblemaps.io` for `bubblemaps.io`, stay available. Accessible branches continue. These are conservative heuristics, not a guarantee that a permitted control cannot change data. Model-driven credential entry, account creation and payment submission remain blocked. The queued worker now offers a private, human-controlled login handoff and optional encrypted app-session reuse; see [private app login](./private-login.md).

A completed run means the bounded execution finished. It does **not** mean all flows were tested or all behavior is correct. Every graph has `coverage_complete: false`; stop reasons distinguish action/model budgets, unstable pages, model stopping, and unreachable or unaffordable remaining branches.

## Usage, durability and training provenance

Exploration allows at most `3 × action_limit + 6` model requests, 2,048 output tokens per request, and one provider attempt per request. Replay permits one assessment per recorded executed action. This bounds work but is not a token or monetary quota. Provider-reported token/cost totals preserve missing data as unknown. Manifests snapshot usage at publication time; the live API is authoritative for calls that settle later.

The gateway drains pending exports in bounded batches, waiting between polls only when idle or after errors. Bucket writes retain conditional creation and hash readback. A PostgreSQL outbox survives unavailable S3/ClickHouse services; exporter lag is not a reason to redispatch a model call.

Simulated-provider runs and the bundled controlled fixture are labeled `excluded_fixture`. Live runs against other explicitly allowed apps are `unreviewed`, not automatically training-eligible. All evidence remains saved for later review/export. Recovery preserves classification from the durable capture metadata, marks interrupted decisions/actions, retries immutable uploads and never replays browser interactions. Use `just recover RUN_UUID` and `just flush`.

## Verified scope and remaining work

The suite covers URL-only execution through the OpenAI, Anthropic and OpenRouter adapters, no-change failure, one-pixel change, graph branching/deduplication, access blocks with continued public coverage, cycle bounds, invented control rejection, invalid assessment evidence, provider outage, uncertain expectations, stale plans, missing before evidence and interruption recovery. The adversarial case proves output validation rejects an invented action; it does not prove that a live model is immune to prompt injection.

The worker supports visible native buttons/links, text/search fields, single-select dropdowns, checkboxes/radios and document scrolling, with three responsive Chromium viewport profiles and at most 120 observed controls per page (including ones further down, which are scrolled into view before acting). Up to `SCOUT_BROWSER_SLOTS` runs are active at once. Unapproved form submission, keyboard shortcuts, custom widgets, nested/horizontal scrolling, iframes, downloads and popup/dialog workflows remain unsupported. Viewport matrix runs are separate concurrent executions, not native-device tests. Other-origin resources and WebSockets are blocked, so apps that depend on them are outside this test setup. Full network/console traces beyond the bounded diagnostic window, semantic state projections, external identity-provider handoff, token/spend quotas and deployment isolation remain unfinished.

Queued explorations can opt into [bounded automatic rechecks](./automatic-reproduction.md) from the URL form. These start after the source completes, use its frozen expectations and viewport in a fresh browser, and retain human review as the confirmation step. CLI and historical runs are not retroactively scheduled.

Target sites run in the `browser-sandbox` containers, which the worker and CLI reach at `SCOUT_BROWSER_ENDPOINT` (set by Compose). Compose starts `SCOUT_BROWSER_SLOTS` of them. Each sandbox has no Scout credentials, volumes or saved logins, joins only the browser network, runs Chromium with its own sandbox and restarts after every run. The worker keeps storage credentials and the saved-login vault and refuses to start without the endpoint. In-process test fixtures, which listen inside the recorder container, still launch Chromium there. `just isolation-test` verifies the boundary; [access and recording boundaries](../../apps/docs/src/content/docs/operators/security.md) lists what the sandbox can still reach. Kubernetes manifests and per-tenant isolation are not implemented; Compose remains the working single-machine path.

The queued worker now supports [private manual app login](./private-login.md). Recognized login pages are omitted from model observation, and authentication changes restart planning under a distinct context. Optional login can be skipped; unavailable access is reported as blocked.

Action completion now precedes assessment and planning. [Bounded waiting, retained intermediate frames, network/console diagnostics and permitted form submission](./action-outcomes.md) extend the same evidence and replay loop. Unresolved completion stops exploration with an inconclusive assessment.

Use **Stop run** in the workspace to cancel active exploration or reproduction. Queued jobs can be cancelled before launch. Evidence and late provider usage remain available; see [cancellation semantics and verification](./cancellation.md).
