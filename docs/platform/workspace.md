# Customer workspace and operator back office

The customer workspace runs at **http://127.0.0.1:18080**, embedded in the Rust API. The operator back office is a separate nginx container at **http://127.0.0.1:18083** that proxies `/v1` to the same API; it is never shipped with the workspace, and the workspace has no links to it. Both are native ES modules without a build step: see [apps/web](../../apps/web/README.md), [apps/backoffice](../../apps/backoffice/README.md) and the shared [packages/web-ui](../../packages/web-ui/README.md). Browser automation runs in the separate TypeScript/Playwright worker.

## Open the app

```sh
just dev    # then open http://127.0.0.1:18080
```

By default (`SCOUT_DEV_AUTH_BYPASS=false`) the workspace asks for a token: a workspace access token, or `SCOUT_API_TOKEN` from `.env` for local development. The back office accepts only the operator token (`SCOUT_API_TOKEN`). Each app keeps the token in the tab's session storage under its own key and sends it as a bearer header; tokens never appear in static assets or URLs, and provider and storage keys stay on the server.

With `SCOUT_DEV_AUTH_BYPASS=true` in `.env` (applied with `just reload-env`), both apps open without a token on literal `localhost`, `127.0.0.1` or `[::1]` addresses with same-origin requests. The browser learns the mode from `/v1/auth-mode`, and the interface shows **Local development · sign-in disabled**. A `SCOUT_PUBLIC_ORIGIN` or Spekios sign-in configuration (`SPEKIOS_*`, see [SPEKIOS_AUTH.md](../../SPEKIOS_AUTH.md)) turns the bypass off.

Stored runs can be reviewed straight away. A live exploration needs a model with a usable key; see [model gateway](./model-gateway.md) and [provider access](./provider-access.md). Saving settings makes no model call, so a configured key is not proof that a live request works.

## Appearance

Every page has a **Match system / Light / Dark** control in its header, repeated under **Settings → Appearance**. Match system is the default. A light or dark choice is stored in this browser (`localStorage` key `scout.theme`) and applied before first paint by `/assets/ui/theme-init.js`. Colors are defined once in `packages/web-ui/src/styles/tokens.css` with `light-dark()`.

## User workspace

- **Launch.** Paste an application URL on the landing page (or **New test**). A bare host such as `app.example.com/login` becomes `https://…`; `localhost`, loopback addresses, `host.docker.internal` and dot-less names with a port (such as `larchwood:8084`) become `http://…`. Any http or https address can be tested, including local and private apps; loopback hosts are rewritten to `host.docker.internal` so the Docker browser can reach them. URLs with embedded credentials are rejected. `SCOUT_ALLOWED_ORIGINS` only lists other private origins that a private page may call. A status line shows whether the model, gateway and browser worker are ready and which model the test will use. Screen size, sign-in, project, model and automatic rechecks sit behind the options summary.
- **Queue.** A launch shows the queued job and opens its run when the worker assigns one. A job that ends before creating a run stays visible with its state and error.
- **Runs.** Search the latest 50 runs by application, run or model and filter by status and live versus fixture data. Fixture runs are labelled **TEST DATA**.
- **Evidence.** Each action shows its frozen expectation and observed outcome, before/after PNGs, the difference mask, settling frames and evidence IDs. **Compare** shows Before and After side by side (stacked on mobile). The evidence drawer shows native pixels or fits the panel, and **Previous / Next** follows the visible action list or Findings filter. The UI does not align screenshots or treat a difference as a defect.
- **Flow.** The Flow tab shows ranked next actions, discovery paths, recorded transitions, return paths and visited, blocked and unvisited controls. Scores are uncalibrated. See [the planner](../exploration/planner.md).
- **Reproduction.** Start one fresh-browser reproduction for an eligible suspected issue and compare its separate evidence. Reproduced candidates still need human review.
- **Automatic rechecks.** **Automatically recheck suspected bugs** (off by default) replays up to two cases and twelve replay actions in total by default, counting prerequisite actions. The source run's **Automatic checks** panel shows reservations, child runs and outcomes. See [automatic reproduction](../exploration/automatic-reproduction.md).
- **Export.** **Export report** downloads Markdown, an evidence ZIP or the run JSON. See [portable reports](../runtime/reports.md).

The run summary separates execution state, application context and action budget; the action meter counts allowed browser actions used, not application coverage. Automatic refresh keeps text entry, selection, open disclosures and scroll positions; a failed refresh keeps the last data with an error notice.

For the bundled test app, run `just fixture` and submit `http://exploration-fixture:8082/branches` (the host preview `http://127.0.0.1:18082` is not the browser's address). `just bug-lab` starts the Larchwood shop at `http://larchwood:8084` (bugs on) and `http://larchwood:8085` (fixed). `just explore-matrix URL` runs desktop, tablet and mobile at once; each appears as a separate run. Browser interactions are described in [browser interactions](../exploration/interactions.md).

## Run controls

Use **Stop run** on an active run or **Cancel queued job** before launch. The queue and run header show **Stopping…** until the worker acknowledges. Cancelled runs keep their evidence, and in-flight model usage may settle later. See [cancellation](../exploration/cancellation.md).

A failed, interrupted or cancelled exploration offers **Continue exploration** beside **Run again**. Continue submits a new job with `continue_from_run_id`: it starts from the earlier run's graph, reopens the page where that run stopped, keeps what was tried, and does not dispatch a control whose earlier outcome is unknown ([continuing an exploration](../exploration/planner.md#continuing-an-exploration)). It uses the current model and limits and requires the same URL and viewport. **Run again** starts a fresh exploration from the entry page with the original request (URL, viewport, sign-in mode, automatic-check choice and project) and the current saved settings; an expired or removed saved sign-in is left out. Blocked explorations and reproductions offer only **Run again**; a job that never started offers **Try again**.

**Stop automatic checks** stays available while automatic planning, reservations or child runs are outstanding, even after the parent finishes. It stops future planning and records stop intent for child jobs and runs in one transaction; completed replays, actions and usage stay recorded.

## Human finding review

The Findings tab filters pending, human-confirmed and dismissed candidates. Confirmation requires verified reproduction evidence, an expectation basis and a severity; it adds a separate human label and keeps the original AI assessment. Drafts survive refresh and conflicts. See [finding reviews](../exploration/finding-reviews.md).

## Settings

**Settings** has one page per section: `/settings/models`, `/settings/exploration`, `/settings/limits`, `/settings/data` (Memory & sessions) and `/settings/appearance`. One draft spans the sections, and a save bar lists the sections with unsaved changes.

| Preference | Accepted values |
| --- | --- |
| Your models (**Models**) | Up to 30 models, each a provider, model ID, optional name (60 characters) and optional input/output prices in USD per million tokens (0–10,000) used for cost estimates |
| Exploration model (**Models**) | A listed OpenRouter, OpenAI, Anthropic or Meta model; ID up to 200 characters of letters, numbers and `/ : . _ -`. Each model can use a saved API key or the demo connection ([provider access](./provider-access.md)) |
| Navigation model (**Models**) | Optional cheaper model for opening pages, following links and scrolling |
| Project models (**Models**) | Up to 50 projects, each a project UUID (what agents send as `project_id`), an optional name, an exploration model and a navigation model. A job with that project uses it unless the job names its own `model` |
| Default viewport (**Exploration**) | Desktop (1920 × 1080), tablet (768 × 1024) or mobile (390 × 844) |
| Strategy (**Exploration**) | Percentage shares for new territory, deep journeys and re-walking known paths, adding up to 100 |
| Automatic checks (**Exploration**) | Default on/off, 1–3 cases, 1–100 total replay actions |
| Limits | Optional maximum actions (1–10,000), minutes (1–10,080), reported tokens and reported cost; empty means no limit. Stop after 50 consecutive actions with nothing new unless changed or turned off |
| Limit overrides | Different limits for a project, a model, or a model within a project (up to 50); the most specific match wins |
| Memory (**Memory & sessions**) | Remember explored pages and controls across runs (on by default; API clients can override with `app_memory`) |

Saving creates an append-only revision (`GET`/`POST /v1/exploration-settings`) that applies to future job admissions without a restart. Queued and running jobs keep the settings they were admitted with, and each job records the resolved model and its source. Environment values (`SCOUT_EXPLORER_*`, `SCOUT_AUTO_REPRODUCE*` in `.env.example`) provide the initial defaults until a revision is saved. Credentials, allowed origins, execution mode and network policy come from the server configuration. The command-line recorder (`just explore`) uses environment settings only.

A save is idempotent by request UUID: an ambiguous response offers **Retry save** with the same values, and a concurrent revision keeps the draft and asks whether to discard it or apply the edits to the latest revision.

**Memory & sessions** lists what earlier runs remembered for each app, screen size and sign-in state (`GET /v1/app-memory`). **Forget** (`POST /v1/app-memory/{scope_id}/forget`) deletes only that derived memory; runs and evidence stay. A scope in use by a running test cannot be forgotten. It also lists saved app sign-in sessions. See [memory across runs](../exploration/planner.md#memory-across-runs) and [private login](../exploration/private-login.md).

## Operator back office

Open **http://127.0.0.1:18083** (`just backoffice`). It is built from `apps/backoffice` and served by its own container (`infra/backoffice`), on loopback only. In production it is published only through Cloudflare Access ([infra/deploy](../../infra/deploy/README.md)). Tabs are addressable as `#/overview`, `#/jobs`, `#/models/<run>`, `#/events/<run>`, `#/logs[/<run>]`, `#/connections` and `#/credits`.

- **Overview** separates worker availability, model-gateway readiness, evidence uploads and ClickHouse event delivery, with run counts, worker heartbeats and pending upload/export counters. The counters come from PostgreSQL; they do not probe the bucket, providers or ClickHouse directly.
- **Jobs** lists the latest 50 browser jobs with search and status and live/simulated filters, worker assignment, timing, errors, cancellation and lineage of automatic reproductions.
- **Models** and **Events** inspect one run: model requests (logical request IDs and actual attempts, frozen input, response text, payload keys, nullable usage) and the ordered execution events. Missing usage or cost shows **Unknown**; incomplete sums show **≥**.
- **Logs** tails every container's output from ClickHouse ([service logs](./logs.md)).
- **Connections** shows provider configuration status, server policy and browser workers, read-only.
- **Demo credits** configures the shared Meta demo key and allowance ([provider access](./provider-access.md)).

The API does not yet restrict every operations endpoint to the operator: a workspace manager token can still call `/v1/operations` and read its own workspace's model requests.

## Queue and recovery

`browser_jobs` stores an immutable request, settings snapshot and execution mode; a job UUID makes submission idempotent. The worker claims queued jobs from every workspace member, up to `SCOUT_BROWSER_SLOTS` (1–8) at once, each holding a PostgreSQL advisory lock on its own connection for its browser slot. Heartbeats are sent every five seconds; a worker is shown unavailable after twenty seconds without one.

Queued jobs survive restarts. If the worker dies during a run, existing evidence is kept and no dispatched action is repeated. Abandoned running jobs become interrupted (or cancelled, if a cancellation was pending) and are never requeued automatically; use **Continue exploration** or **Run again**. Live and simulated jobs run only when the gateway is in the matching mode.

Screenshot and artifact endpoints look the UUID up within the authenticated workspace, load the object key server-side and verify length and SHA-256 before returning bytes; the browser never receives bucket credentials. Page text, model output and event payloads are rendered as escaped text under a same-origin content security policy.

## Tests

```sh
just web-test               # node --test for apps/web, packages/web-ui and apps/backoffice; no browser
just web-contract-test      # render stored runs through the UI templates; stack running
just workspace-test         # API, queue and real worker with simulated models
just settings-test          # exploration-settings API and PostgreSQL; no browser or model calls
just report-export-test     # stored-run exports checked by an independent ZIP reader
just auto-reproduction-test # automatic scheduler and worker with real Chromium, simulated models
```

The fixture suites refuse to restart services while runs, jobs or model requests are active.
