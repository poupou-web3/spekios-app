# Spekios architecture

Spekios is an exploratory QA system. Given only a URL, it explores the app in a real Chromium browser, predicts the result of each action before taking it, records before/after screenshots and an assessment, reproduces suspected bugs in a fresh browser, and hands the results to people (workspace, issues page) and to coding agents (MCP, HTTP tools, CLI, reports).

Internal names still use `scout` (the `scout-api` binary, `scout_*` MCP tools, `SCOUT_*` settings, the `scout` database). The public, operator-facing version of this page is [How the services fit together](../../apps/docs/src/content/docs/operators/architecture.md).

## Components

| Component | Code | Role |
| --- | --- | --- |
| API | `apps/api` (Rust, Axum) | Serves the workspace UI, the `/v1` REST API, MCP at `/mcp`, the plain HTTP tool catalog at `/v1/agent/tools`, agent OAuth and browser pairing, optional [Spekios human sign-in](../../SPEKIOS_AUTH.md), and the model gateway (`/v1/model-requests`). Published on port 18080. |
| MCP stdio bridge | `apps/api/src/bin/scout-mcp.rs` | Local `scout-mcp` binary that forwards stdio JSON-RPC to the API's `/mcp`. See [agent interface](../agents/interface.md). |
| Workspace UI | `apps/web`, `packages/web-ui` | Plain HTML/JS, no build step, embedded in the API binary: workspace, `/issues`, `/connect`, `/settings`. Polls the API every 5 seconds. |
| Back office | `apps/backoffice`, `infra/backoffice` | Operator console (jobs, model calls, events, logs, connections) served by nginx on port 18083; proxies `/v1` and `/readyz` to the API and signs in with the operator token. |
| Browser worker | `packages/browser-runtime/src/worker.ts` | Claims jobs from PostgreSQL and runs exploration, reproduction and fix verification. Holds storage credentials and the saved-login vault. Runs up to `SCOUT_BROWSER_SLOTS` jobs at once (default 3). |
| Browser sandbox | `packages/browser-runtime/src/browser-server.ts` | Runs Chromium for every target page, one replica per slot, with no Spekios credentials, volumes or storage network. The worker drives it over `ws://browser-sandbox:3000/browser`. |
| Recorder CLI | `packages/browser-runtime/src/cli.ts` | One-off runs for `just demo`, `just explore`, `just explore-matrix`, `just reproduce`. |
| PostHog worker | `packages/browser-runtime/src/posthog-worker.ts` | Imports journeys from PostHog Cloud. See [PostHog](../platform/posthog.md). |
| Image diff | `packages/image-diff` | Exact pixel difference masks between captures. |
| CLI | `packages/cli` | `spekios` command for agents; talks to the same HTTP API. |
| PostgreSQL | `infra/postgres` | Authoritative state: jobs, runs, actions, settings, issues, reviews, model requests, identities and outbox rows. |
| Evidence store | SeaweedFS (S3 API), bucket `qa-evidence` | Screenshots, masks, JSON artifacts and model payloads. Database rows hold keys and hashes. |
| ClickHouse | `infra/clickhouse` | Analytical copy of runtime, model, identity and issue events, plus service logs. Never the source of truth. |
| Log collection | `log-socket`, `log-collector` (Vector, `infra/logs`) | Tails container logs into ClickHouse for the back office Logs tab. See [logs](../platform/logs.md). |
| Public docs | `apps/docs` (Astro) | Static docs site, built and served separately (`compose.docs.yaml`). |
| Test apps | `apps/bug-lab`, `exploration-fixture` | Larchwood shop with known bugs and the deterministic fixture used by tests. |
| Deployment | `infra/deploy`, `compose.deploy.yaml` | Terraform (Hetzner, Cloudflare), Ansible, and a Caddy HTTPS edge. See [deployment](../platform/deployment.md). |

Schema files in `infra/postgres` and `infra/clickhouse` run in filename order on a fresh volume. `just dev` (via `scripts/bootstrap-local.mjs`) and `scripts/deploy.sh` (via `scripts/apply-schemas.sh`) re-apply them to existing volumes.

## How a run works

1. A client (workspace, MCP, HTTP tool call or CLI) submits a URL with a caller-chosen job UUID, through `POST /v1/browser-jobs` or `scout_start_exploration`. The API checks identity, workspace scope, the target URL and provider settings, freezes the run settings and stores a durable job. Retrying with the same UUID and input reuses the job.
2. The browser worker claims the job and opens a fresh sandbox browser.
3. Each step: the [frontier planner](../exploration/planner.md) picks the next control (new territory, deeper journeys and re-walks of the app map, 50/30/20 by default); the model call goes through the API gateway, which reads screenshots by capture ID; the expected result is frozen before the action; before/after captures, the difference mask, browser diagnostics and the assessment are recorded.
4. Records go to PostgreSQL and bytes to the evidence bucket. Events reach ClickHouse through retryable outboxes.
5. Suspected bugs become permanent issues. They can be reproduced in a fresh browser (manually or [automatically](../exploration/automatic-reproduction.md)), triaged as bug, intended behavior, duplicate or needs review, reviewed by a person, and rechecked against a candidate deployment (`scout_verify_fix`, `scout_recheck_deployment`, `just recheck`, `scripts/scout-recheck.mjs`).
6. Clients read progress, reports and evidence from PostgreSQL projections. There is no push channel; the UI and agents poll.

Models are called with API keys (OpenAI, Anthropic, OpenRouter, Meta); per-run, per-project and default model selection is supported. See [model gateway](../platform/model-gateway.md).

## Rules the code keeps

- PostgreSQL is authoritative. A ClickHouse outage leaves outbox rows pending; it never loses an action or decides job state.
- Every dispatched action has a prediction frozen before dispatch, uniquely identified before/after captures (or an explicit capture failure), a difference mask and an assessment. A small or zero pixel change can still be a bug; a large change is not a verdict.
- Reproduction uses a fresh browser and separate evidence. A reproduced suspicion is not a human confirmation; human reviews are append-only and kept separate from model judgments. Agent triage cannot replace a person's decision.
- Missing usage stays unknown, never zero.
- Target pages run only in the sandbox. Forms with credential, payment or wallet fields are treated as unsafe for autonomous submission; private sign-in is a human handoff ([private login](../exploration/private-login.md)).
- Run limits (actions, minutes, tokens, cost) are optional per user, project and run; there is no limit by default ([exploration limits](../../apps/docs/src/content/docs/guides/exploration-limits.md)).

## Not built yet

These are product directions, not current behavior:

- A chat-style session conversation. Today a run's focus can be changed through [steering](../../apps/docs/src/content/docs/guides/testing-focus.md).
- A built-in scheduler. Run `scripts/scout-recheck.mjs` from CI or cron instead.
- Hand-written test cases and export of found flows as reviewable Playwright tests.
- Free-text product knowledge. Known behavior today comes only from issue triage.
- Workspace-wide spend budgets, quotas and billing.
- Push updates (server-sent events or subscriptions) for the UI and agents.
- An external browser driver, where a connected agent supplies each observe/act/assess step with its own model.
- Repository context: Spekios does not read the target's source code.
- Versioned training-dataset exports with reviewed labels.
- Native mobile apps and browsers other than Chromium.
- Kubernetes manifests.
