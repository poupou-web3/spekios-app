# scout-api (Rust)

The Spekios control plane: a Rust 2024 Axum/Tokio service (crate `scout-api`). It:

- serves the customer workspace (`apps/web`), the shared UI kit (`packages/web-ui/src`) and the CLI download (`packages/cli`), all embedded at compile time by `build.rs`;
- exposes the `/v1` REST API, the MCP endpoint `POST /mcp` and the same agent tools over plain HTTP (`/v1/agent/tools`);
- admits browser jobs (`explore`, `reproduce`, `verify_fix`) into PostgreSQL, where the browser worker in `packages/browser-runtime` claims them;
- runs the durable model gateway (`/v1/model-requests`) that the browser worker calls for every model request, with OpenAI, Anthropic, OpenRouter and Meta providers;
- handles sign-in: Spekios hosted login with server-side sessions, browser-approved agent credentials, OAuth for MCP clients, and the operator token.

It reads and writes PostgreSQL (schema in `infra/postgres`), reads and writes evidence in the S3-compatible `qa-evidence` bucket, exports model-gateway events to ClickHouse and reads it for the back office Logs tab. The operator back office (`apps/backoffice`) is a separate nginx deployment that proxies `/v1` to this service; it is not embedded here.

A second binary, `scout-mcp` (`src/bin/scout-mcp.rs`), bridges local stdio MCP clients to `/mcp` and handles `scout-mcp login` / `logout` for browser-approved agent credentials.

## Layout

```
build.rs              embeds apps/web, packages/web-ui/src and the CLI package
src/main.rs           configuration from the environment, startup
src/lib.rs            router, authentication middleware, capabilities, readiness
src/agent.rs, agent/  MCP/HTTP agent tools (catalog.rs) and coding-agent reports
src/gateway.rs        model gateway; models.rs, provider_access.rs, computer_use.rs
src/jobs.rs           browser-job admission, projects, exploration settings
src/runs.rs, ui.rs    run snapshots, graphs, evidence retrieval, embedded assets
src/issues.rs         persistent issues, triage, knowledge, fix verification, rechecks
src/reviews.rs, steering.rs, memory.rs, access.rs, history.rs, posthog.rs, logs.rs
src/identity.rs, oauth.rs, web_auth.rs   agent credentials, OAuth, human sign-in
examples/export_agent_catalog.rs         prints the tool catalog for apps/docs
```

## Run

`just up` (or `just dev`) starts the stack; the API is published on http://127.0.0.1:18080. The image is built from `infra/api/Dockerfile`, which runs `cargo test` before the release build. After changing Rust or embedded UI code, `just reload-api` rebuilds only this container. `just logs` tails it.

`scripts/setup-local.mjs` (run by `just up`) writes the ignored `.env`, including `SCOUT_API_TOKEN`, the operator token. Use `just runs`, `just run RUN_ID`, `just jobs` or `just operations` to read the API without putting the token in shell history.

Main environment variables (see `compose.yaml` for the full list and defaults):

| Variable | Purpose |
| --- | --- |
| `SCOUT_API_TOKEN` | Operator bearer token (required) |
| `SCOUT_API_BIND` | Listen address; defaults to `127.0.0.1:18080`, Compose uses `0.0.0.0:8080` |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `POSTGRES_PASSWORD`, `PGSSLMODE` | PostgreSQL; without `PGHOST` only the UI and liveness routes work |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Evidence bucket |
| `CLICKHOUSE_PASSWORD` | Model-event export and back office log reads |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `META_API_KEY` (or `MODEL_API_KEY`) | Server-wide provider keys |
| `SCOUT_PROVIDER_VAULT_KEY` | Encrypts per-account saved provider keys |
| `SCOUT_EXPLORER_*`, `SCOUT_AUTO_REPRODUCE*` | Exploration defaults until a user saves settings |
| `SCOUT_ALLOWED_ORIGINS` | Private or HTTP origins jobs may target (public HTTPS is always allowed) |
| `SCOUT_DEV_AUTH_BYPASS` | `true` admits tokenless requests from literal loopback hosts, for local UI work; default `false` |
| `SCOUT_PUBLIC_ORIGIN`, `SPEKIOS_*` | Public origin and Spekios hosted-login client ([SPEKIOS_AUTH.md](../../SPEKIOS_AUTH.md)) |

## Test

```sh
just api-check   # cargo check
just api-test    # cargo test --lib --bins (needs rustc 1.91 or newer)
```

Integration suites that exercise the API with real databases and simulated models live under `scripts/` and are run through `just`, for example `just model-test`, `just workspace-test`, `just settings-test`, `just agent-test`, `just identity-test`, `just cancellation-test` and `node scripts/verify-api.mjs`. They restart services and need the stack running; see the root `justfile` for the full list.

## Further reading

- [Agent interface](../../docs/agents/interface.md): MCP/HTTP tools, authentication, schemas
- [Model gateway](../../docs/platform/model-gateway.md): providers, evidence, usage, recovery
- [Workspace and back office](../../docs/platform/workspace.md)
- [Exploration](../../docs/exploration/overview.md), [cancellation](../../docs/exploration/cancellation.md), [automatic reproduction](../../docs/exploration/automatic-reproduction.md), [finding reviews](../../docs/exploration/finding-reviews.md), [triage](../../docs/exploration/triage.md)
- [Portable run reports](../../docs/runtime/reports.md)
- The public API reference is generated by `apps/docs` (`openapi.json`, `mcp-tools.json`).
