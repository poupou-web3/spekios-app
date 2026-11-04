# Local stack

Everything runs in one Docker Compose project, `scout-qa`, driven by the repository `justfile`. To run the same stack as a host deployment, see [deployment](./deployment.md).

## Requirements

- Docker with Compose v2.
- Node.js 22 or newer, for the setup and utility scripts in `scripts/`. The API itself does not run Node.
- [just](https://just.systems/man/en/).
- Optional: a Rust toolchain for `just api-test`, `just mcp-build` and the tests that build the API natively; Node.js 24 for the docs site (`just docs-dev`).

## Start

```sh
just dev     # same as `just up`: bash scripts/start-local.sh
```

`scripts/start-local.sh`:

1. Runs `scripts/setup-local.mjs`, which creates `.env` with independent random credentials (`POSTGRES_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `CLICKHOUSE_PASSWORD`, `SCOUT_API_TOKEN`, `SCOUT_PROVIDER_VAULT_KEY`) and mode `0600`, or validates and keeps an existing one.
2. Installs the script dependencies (`npm ci --prefix scripts`).
3. Builds and starts every default Compose service and waits for health checks.
4. Applies the PostgreSQL and ClickHouse schemas (`scripts/bootstrap-local.mjs`) and waits for the API.

Optional settings (provider keys, exploration defaults, allowed origins, sign-in) are documented in `.env.example`; copy the lines you need into `.env`. Run `just reload-env` after editing `.env` to recreate the API with the new values. Changing a password in `.env` does not rotate a credential already stored in a database volume.

| Address | What |
| --- | --- |
| `http://127.0.0.1:18080` | Customer workspace and API ([workspace](./workspace.md)) |
| `http://127.0.0.1:18083` | Operator back office |
| `http://127.0.0.1:18333` | S3 API of the evidence bucket |
| `http://127.0.0.1:18123` | ClickHouse HTTP |
| `http://127.0.0.1:18090` | Docs site, started separately with `just docs-up` |

Every published port binds to loopback. PostgreSQL has no host port. With the default `SCOUT_DEV_AUTH_BYPASS=false`, the workspace asks for a token: paste `SCOUT_API_TOKEN` from `.env`. Setting `SCOUT_DEV_AUTH_BYPASS=true` skips the token screen on literal `localhost`/`127.0.0.1` addresses.

No model key is needed to browse stored runs or run the fixture tests. A live exploration needs a model: add a personal key in **Settings → Models**, or set `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `META_API_KEY` in `.env` ([model gateway](./model-gateway.md)).

## Common commands

`just --list` shows every recipe. The everyday ones:

```sh
just status             # docker compose ps
just stop               # stop containers, keep volumes
just reload             # rebuild the API (with the embedded workspace) and the back office
just reload-api         # rebuild only the API and workspace
just reload-backoffice  # rebuild only the back office
just reload-env         # recreate the API so it reads the current .env
just logs               # last 100 API log lines
just runs               # latest runs through the API (token not printed)
just run RUN_UUID       # one run with its evidence references
just jobs               # browser jobs and worker heartbeats
just models             # configured providers, without keys
just usage              # model usage for the current mode
just fixture            # controlled test app: http://exploration-fixture:8082 inside Compose, 127.0.0.1:18082 on the host
just bug-lab            # Larchwood shop with known bugs: http://larchwood:8084 (bugs) and :8085 (fixed)
just explore URL        # one exploration from the command line
just explore-matrix URL # desktop, tablet and mobile at once
just test               # API, runtime, web and script tests; the stack must be running
```

`just model-test`, `just workspace-test` and the other fixture suites briefly restart services in a simulated-model mode and restore normal mode afterwards. Run them while the workspace is idle.

## Services

| Service | Image | Host access | Data | Limit |
| --- | --- | --- | --- | --- |
| `api` | Rust 1.91 build, Axum 0.8.9 | `127.0.0.1:18080` | `gateway-spool` (model response journals) | 256 MiB, 1 CPU |
| `backoffice` | nginx (unprivileged), proxies `/v1` to the API | `127.0.0.1:18083` | none | 64 MiB, 0.5 CPU |
| `postgres` | PostgreSQL 17.11 | none | `postgres-data` | 512 MiB, 1 CPU |
| `evidence` | SeaweedFS 4.48, bucket `qa-evidence` | `127.0.0.1:18333` | `evidence-data` | 1 GiB, 1 CPU |
| `clickhouse` | ClickHouse 26.7.35.11 | `127.0.0.1:18123` | `clickhouse-data` | 2 GiB, 2 CPUs |
| `browser-worker` | Playwright 1.64.0 image, job queue | none | `recorder-spool`, `auth-vault` | 1 GiB, 2 CPUs |
| `browser-sandbox` | Same image, Chromium only; `SCOUT_BROWSER_SLOTS` replicas | none | none | 1 GiB, 2 CPUs each |
| `posthog-worker` | Same image, [PostHog](./posthog.md) importer | none | PostgreSQL | 384 MiB, 0.5 CPU |
| `log-socket`, `log-collector` | socket-proxy 1.13.1, Vector 0.60.0 | none | ClickHouse `scout.service_logs` | 32 MiB / 0.25 CPU; 128 MiB / 0.5 CPU |
| `recorder` (profile `runtime`) | Same image, one-shot CLI (`just explore`, `just demo`) | none | `recorder-spool`, `auth-vault` | 1 GiB, 2 CPUs |
| `exploration-fixture`, `larchwood` (profile `runtime`) | Same image | `18082`; `18084`/`18085` | none | 128 MiB |

Images are pinned by digest in Compose or the Dockerfiles under `infra/`. PostgreSQL and ClickHouse use small derived images that contain their schema and configuration files. Application containers run read-only with all capabilities dropped.

Networks: `default` connects the application and storage. `browser` connects the worker, the sandboxes and the test apps; storage and the model gateway are not on it. `logs` is internal and holds only the log collector and its Docker API proxy.

Model, browser and archive events reach ClickHouse through durable PostgreSQL outboxes; container output reaches it through the [log collector](./logs.md). There is no Redis, Kubernetes or OpenTelemetry collector.

## Persistence

Use `just stop` when idle and `just dev` to resume. Keep the named volumes and `.env` together; removing volumes deletes the evidence and databases. The evidence bucket is a local volume, not an off-machine backup, and nothing expires evidence automatically.

## Reference screenshot archive

The tracked [manifest](../../artifacts/reference-screenshots/manifest.json) lists seven design-reference screenshots with capture IDs, SHA-256 hashes and object keys (`design-reference/...` in `qa-evidence`). They are labelled `purpose: design_reference` and `training_status: excluded_reference`; they are not browser observations.

```sh
node scripts/archive-reference-screenshots.mjs   # archive the files listed in scripts/reference-sources.json
node scripts/verify-local.mjs                    # verify the archive (also part of `just test`)
node scripts/get-reference-capture.mjs CAPTURE_UUID /path/to/new-file.png
```

The archive script needs the original files at the paths in `scripts/reference-sources.json`; changed inputs are rejected and existing IDs are preserved. `just test` runs the verifier, so it fails on a machine where the archive was never created. Retrieval verifies the checksum and refuses to overwrite an existing file.

## ClickHouse memory

The local server is capped at 2 GiB. `infra/clickhouse/limits.xml` limits merge blocks to 128 rows and 1 MiB and enables vertical merges for every part, because wide `system.metric_log` rows otherwise made background merges exceed the memory limit and reject Spekios inserts. Changes apply when the ClickHouse image is rebuilt.
