# URL-driven exploration

A bounded browser loop connected to the Rust model gateway. It starts from a URL, ranks likely actions using the observed path and changed controls, returns to unexplored branches, replans stale decisions, and assesses every action from its before and after screenshots. A run records its flow graph, selection reasons, predictions, assessments, model request IDs and token usage. See [the exploration algorithm](./planner.md) for scoring and routing.

## Run it

From the workspace at **http://127.0.0.1:18080**: submit a URL, follow the queued job, then inspect actions, screenshot masks, the flow graph and reproduction results. A background worker executes queued jobs. See [workspace](../platform/workspace.md).

From the command line (repository root):

```sh
just dev
just fixture
just explore http://exploration-fixture:8082/branches
just explore-matrix http://exploration-fixture:8082/responsive
just runs
just run RUN_UUID
just graph RUN_UUID
just usage
```

Replace `RUN_UUID` with the printed ID. The browser runs inside Compose: `exploration-fixture:8082` is the fixture's internal address and `127.0.0.1:18082` its host preview. Any http or https address the browser container can reach can be submitted. The API rewrites loopback hosts (`localhost`, `127.0.0.1`, `0.0.0.0`) in queued jobs to `host.docker.internal`, which reaches your machine under Docker Desktop.

For live inference, add a provider API key to the private `.env`, as described in [model gateway](../platform/model-gateway.md). Without one, use the simulated-provider test suites below.

| Setting | Default | Meaning |
| --- | --- | --- |
| `SCOUT_EXPLORER_PROVIDER` | `openrouter` | `openai`, `anthropic`, `openrouter` or `meta`. Server default only: Settings can replace it per user, per project and per run |
| `SCOUT_EXPLORER_MODEL` | `openrouter/free` | Model ID. When empty, OpenRouter uses `openrouter/free` and Meta `muse-wonder-1.0` |
| `SCOUT_EXPLORER_FREE_ONLY` | `true` | OpenRouter free-route constraint; not applicable to direct OpenAI, Anthropic or Meta billing |
| `SCOUT_EXPLORER_MAX_ACTIONS` | empty | Server default for users without saved limits; empty means no limit. Integer 1–10000; includes navigation, returns and resumes |
| `SCOUT_EXPLORER_MAX_MINUTES` | empty | Server default wall-clock limit per exploration; empty means no limit. Integer 1–10080 |
| `SCOUT_EXPLORER_APP_MEMORY` | `true` | Default for remembering explored pages and controls across runs; see [memory across runs](./planner.md#memory-across-runs) |
| `SCOUT_EXPLORER_VIEWPORT` | `desktop` | `desktop` (1920×1080), `tablet` (768×1024) or `mobile` (390×844) |
| `SCOUT_ALLOWED_ORIGINS` | `http://exploration-fixture:8082,http://larchwood:8084,http://larchwood:8085` | Extra private or HTTP origins that a non-public page may load subresources from. The submitted URL itself does not need an entry |
| `SCOUT_BROWSER_SLOTS` | `3` | Runs active at once; Compose starts this many `browser-sandbox` containers. Integer 1–8 |
| `SCOUT_CHROMIUM_SANDBOX` | `true` | Chromium's own sandbox inside the browser sandbox container. The container uses [seccomp-chromium.json](../../infra/recorder/seccomp-chromium.json) (Docker's default profile plus clone/unshare/setns/chroot). On Ubuntu 24.04 the host also needs `kernel.apparmor_restrict_unprivileged_userns=0`; [infra/deploy](../../infra/deploy/README.md) sets it. Set `false` only on hosts where Chromium still cannot start it |

## Action and evidence contract

1. The model predicts the initial navigation, or ranks up to eight candidates from the current state's observed controls. Every candidate has a goal, likelihood and expected result. All model requests and responses pass through the durable gateway.
2. The selected prediction and action are committed before dispatch. Run, agent, worker, action, prediction, model decision and model request IDs establish lineage.
3. A fresh before screenshot is saved and compared with the planning observation on URL, controls and visible text. Clock and date labels share an identity, and scroll positions within 8 pixels do too. A change skips the stale action before dispatch, records a new state and change mask, and triggers replanning (see [page drift](./planner.md#page-drift-and-bounds)).
4. The worker validates a typed interaction against an observed control, records dispatch, executes once, waits for the [action outcome](./action-outcomes.md), and saves the after screenshot. Models cannot supply JavaScript, selectors or new tools. See [browser interactions](./interactions.md) for the supported actions.
5. Exact subtraction produces the binary mask and channel delta, including one-pixel changes. Screenshots and derivatives are immutable bucket objects. Identical PNG bytes share a blob; each capture occurrence still gets its own UUID.
6. Before/after IDs, comparison and graph edge commit before assessment. The model receives the screenshots, bounded DOM observations, the frozen prediction, recent history, the action outcome and mask statistics. For an in-page action with changed pixels, the first assessment uses native-resolution crops of the changed regions plus a reduced whole-page overview; any result other than `no_issue_observed`, or a request for more context, triggers a full-screenshot assessment.
7. Every executed action is assessed, including a zero-change mask. The result must reference the exact captures. Tool, observation or completion errors and uncertain expectations force `inconclusive`. Use `just reproduce ACTION_UUID` to check a suspect action in a fresh browser; [reproduction outcomes](./reproduction.md) keep `confirmed_bug: false` until a [human review](./finding-reviews.md).

If a model assessment fails, available screenshots, masks and the executed edge remain recorded and no next action runs. Missing before evidence prevents dispatch. Model requests use stable UUIDs, so a lost admission acknowledgement can be retried without creating another logical request.

Screenshots and DOM reads are sequential observations, not an atomic view of a dynamic application. During capture the page clock is paused, CSS animations are held on their initial frame, reduced motion is requested and the caret is hidden. No video is recorded.

## Flow graph and access blocks

PostgreSQL stores states, action edges, a frontier of observed controls, and model decisions. `GET /v1/runs/{id}/graph` returns the graph; the run report and immutable bucket manifest include it too. Runtime events export to ClickHouse; model calls keep their own request/response payloads and usage ledger.

State identity is the URL, visible text, controls, viewport, authentication context and an 8-pixel scroll bucket. Clock, date and relative-time labels fold into one value. Screenshot bytes do not create another graph node.

Ambiguous, disabled or covered controls, unapproved form submissions, links outside the entry site's registered domain, and recognizable credential, payment or destructive controls are recorded as blocked. Subdomains of the entry site's registered domain (for example `v2.bubblemaps.io` for `bubblemaps.io`) stay available. These are conservative heuristics, not a guarantee that a permitted control cannot change data. Model-driven credential entry, account creation and payment submission stay blocked; sign-in is a [human handoff](./private-login.md).

Subresources may come from the page's own origin and any public HTTPS or WSS origin. A page on a private or HTTP origin may additionally load from origins in `SCOUT_ALLOWED_ORIGINS`. A top-level navigation stays on the entry site's registered domain.

A completed run means the bounded execution finished, not that all flows were tested. Every graph has `coverage_complete: false`; stop reasons are listed in [page drift and bounds](./planner.md#page-drift-and-bounds).

## Usage, durability and training provenance

With an action limit, exploration allows at most `3 × action_limit + 6` model requests (`4 × action_limit + 6` with a navigation model), 4,096 output tokens per request, and one provider attempt per request. Replay allows one assessment per recorded action. These bound work; token and cost limits are separate settings. Unknown provider-reported usage stays unknown. Manifests snapshot usage at publication; the live API is authoritative for calls that settle later.

Bucket writes use conditional creation and hash readback. A PostgreSQL outbox survives unavailable S3 or ClickHouse; exporter lag never redispatches a model call.

Simulated-provider runs and the bundled fixture are labelled `excluded_fixture`. Live runs against other apps are `unreviewed`, not automatically training-eligible. Recovery keeps the classification, marks interrupted decisions and actions, retries immutable uploads and never replays browser interactions. Use `just recover RUN_UUID` and `just flush`.

## Browser isolation

Target sites run in the `browser-sandbox` containers, which the worker and CLI reach at `SCOUT_BROWSER_ENDPOINT` (set by Compose). Each sandbox has no Spekios credentials, volumes or saved logins, joins only the browser network, runs Chromium with its own sandbox and restarts after every run. The worker keeps storage credentials and the saved-login vault, and refuses to start without the endpoint. In-process test fixtures still launch Chromium inside the recorder container. `just isolation-test` checks the boundary; [access and recording boundaries](../../apps/docs/src/content/docs/operators/security.md) lists what the sandbox can still reach.

Viewport matrix runs are separate concurrent runs, not native-device tests.

## Related

- [Stopping a run](./cancellation.md): **Stop run** and **Cancel queued job**; evidence and late provider usage are kept.
- [Automatic rechecks](./automatic-reproduction.md): optional fresh-browser checks of suspects after a queued exploration.
- [Continue an exploration](./planner.md#continuing-an-exploration) from the graph a stopped run explored.

## Tests

`just explorer-test` runs exploration and reproduction integration cases with simulated model responses and real Chromium, PostgreSQL, S3 and ClickHouse, then restores normal provider configuration. Real keys are ignored. It does not measure real-model QA quality. Results go to `artifacts/explorer/verification.json` and `artifacts/reproduction/verification.json` (generated, not committed).

## Not built yet

- Unapproved form submission, keyboard shortcuts, custom widgets, nested or horizontal scrolling (except [Meta computer-use recovery](./computer-use.md)), iframes, downloads, and popup or dialog workflows.
- External identity-provider sign-in (Google/OAuth).
- Kubernetes manifests and per-tenant isolation; Compose is the working single-machine path.
- Live-model quality evaluation and score calibration.
