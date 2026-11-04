# Spekios

Spekios is exploratory QA for web apps. Give it a URL and it explores the app in a real Chromium browser:

1. Before each action, it predicts what should happen.
2. It records before/after screenshots.
3. It flags anything that doesn't match the prediction.

Suspected bugs can be replayed in a fresh browser and reviewed by a person. After a fix they can be rechecked against a new deployment.

People use the web workspace. Coding agents use the same jobs and evidence over MCP, HTTP or a CLI.

## Architecture

```
  Workspace UI ─┐
  Back office ──┤                       ┌─► PostgreSQL   (source of truth)
  MCP / HTTP ───┼──► API (Rust/Axum) ───┼─► S3 bucket    (screenshots, artifacts)
  spekios CLI ──┘    + model gateway    └─► ClickHouse   (event & log analytics)
                          ▲
                          │ model calls
                          │
                    Browser worker ──── job queue in PostgreSQL
                          │
                          ▼
                    Browser sandbox (Chromium, no credentials) ──► the app under test
```

| Component | Path | What it does |
| --- | --- | --- |
| API | `apps/api` | Rust/Axum server, the single entry point. It serves the workspace UI, the `/v1` REST API, MCP at `/mcp`, agent sign-in and the model gateway (OpenAI, Anthropic, OpenRouter, Meta). |
| Workspace | `apps/web`, `packages/web-ui` | Plain HTML/JS UI, embedded in the API binary. |
| Back office | `apps/backoffice` | Operator console for jobs, model calls, events and live logs. It runs as a separate nginx container. |
| Browser runtime | `packages/browser-runtime` | TypeScript/Playwright. The worker claims jobs and drives Chromium in isolated sandbox containers. All model calls go through the API. |
| Image diff | `packages/image-diff` | Pixel-exact screenshot differences. |
| CLI | `packages/cli` | `spekios` command for agents. |
| Docs site | `apps/docs` | Public documentation (Astro), built and served on its own. |
| Test apps | `apps/bug-lab` | Larchwood, a shop with 14 known bugs, for measuring what an exploration finds. |
| Infra | `infra/` | Database schemas, Dockerfiles and the production deployment (Terraform + Ansible). |

Everything runs under Docker Compose (`compose.yaml`). Commands are in the `justfile`.

Internal identifiers still use the old name `scout`, for example `scout_*` MCP tools and `SCOUT_*` settings.

## Install and run locally

You need:

- Docker with Compose v2
- Node.js 22+
- [`just`](https://just.systems)

Rust is only needed for the API tests and the MCP stdio bridge.

```sh
just dev
```

This creates a private `.env` with random credentials, builds and starts the stack, and applies the database schemas.

Then open:

| | URL |
| --- | --- |
| Workspace and API | http://127.0.0.1:18080 |
| Back office | http://127.0.0.1:18083 |

Both ask for a token. Paste `SCOUT_API_TOKEN` from `.env`. For local development only, you can skip the workspace token screen: set `SCOUT_DEV_AUTH_BYPASS=true` in `.env`, then run `just reload-env`.

### Add a model

Explorations need a model provider. Use either:

- **An API key in the workspace:** add it under **Settings**.
- **A provider key in `.env`:** set `OPENROUTER_API_KEY` (the default is a free OpenRouter model), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `META_API_KEY`, then run `just reload-env`.

See `.env.example` for every setting.

### Run your first exploration

Paste a URL in the workspace and start testing. Any http(s) address works, and `localhost` URLs are reached through Docker Desktop's `host.docker.internal`.

To try it on a shop with known bugs:

```sh
just bug-lab                  # starts Larchwood
# explore http://larchwood:8084 from the workspace, then:
just bug-lab-score RUN_ID     # what was found, missed or wrongly flagged
```

### Connect a coding agent

- **Remote agent app:** open **Connect your agent** in the workspace and add the MCP URL it shows. You approve the connection in your browser.
- **Local stdio bridge:** run `just mcp-build`, then `just mcp-config`.
- **Agent CLI:** see [packages/cli](./packages/cli/README.md).
- **Workflow skill:** `python3 scripts/install-scout-skill.py --client claude` installs a small workflow skill (use `--client codex` for Codex).

## Common commands

| Command | What it does |
| --- | --- |
| `just dev` | Start or update the local stack |
| `just stop` | Stop it, keeping data volumes |
| `just status` | Container status |
| `just logs` | Recent API logs (all services: back office **Logs** tab) |
| `just reload` | Rebuild the workspace and back office after a UI change |
| `just reload-env` | Restart the API after editing `.env` |
| `just explore URL` | Run an exploration from the terminal |
| `just runs` | List recent runs |
| `just export-report RUN_ID` | Export a run as Markdown, JSON or an evidence ZIP |
| `just docs-up` | Serve the docs site at http://127.0.0.1:18090 |

### Tests

| Command | What it tests |
| --- | --- |
| `just web-test` | Workspace and back-office UI |
| `just api-test` | Rust API (needs Rust) |
| `just runtime-test` | Browser runtime |
| `just docs-test` | Docs site |

Feature suites such as `just explorer-test`, `just fix-verification-test` and `just isolation-test` run against the live local stack with simulated models.

## Deploy

`just deploy` runs the same stack on one host. Services stay on loopback unless `SCOUT_PUBLISH` is set.

`just deploy edge` adds a Caddy HTTPS edge. Set `SCOUT_PUBLIC_HOST` and `SCOUT_PUBLIC_ORIGIN` first.

Production runs on Hetzner behind Cloudflare and is always deployed from `origin/main`. See [infra/deploy](./infra/deploy/README.md) and [deployment](./docs/platform/deployment.md).

## Optional integrations

- **PostHog:** import recorded user journeys from PostHog Cloud and replay them as test flows. See the [PostHog guide](./docs/platform/posthog.md) and the [demo shop](./apps/posthog-demo/README.md).
- **Spekios sign-in:** hosted Google, Apple and email login for the workspace. See [SPEKIOS_AUTH.md](./SPEKIOS_AUTH.md).

## Documentation

- **[User guide](./apps/docs/README.md):** the published docs site. It covers getting started, guides, agents and the API.
- **[Engineering notes](./docs/README.md):** architecture, the exploration planner, runtime, evidence and platform details.
- **[AGENTS.md](./AGENTS.md):** rules for coding agents working in this repo.
