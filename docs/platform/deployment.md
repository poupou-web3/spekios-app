# Deployment

Spekios deploys as one Docker Compose project (`scout-qa`) on one machine. The local development stack is described in [local stack](./infrastructure.md); this page covers running the same stack as a host deployment. The production host on Hetzner and Cloudflare is set up by [infra/deploy](../../infra/deploy/README.md), which calls the same script.

## Deploy on one machine

```sh
just deploy          # scripts/deploy.sh
just deploy edge     # also start the Caddy HTTPS edge on ports 80 and 443
just deploy-stop     # stop every container, including the edge; keep the volumes
```

`scripts/deploy.sh`:

1. Preserves or creates the private `.env` (`scripts/setup-local.mjs` when Node is installed, otherwise OpenSSL) and adds `SCOUT_PROVIDER_VAULT_KEY` if it is missing.
2. Uses `COMPOSE_FILE=compose.yaml:compose.deploy.yaml`, plus the overlays chosen below.
3. Starts PostgreSQL, ClickHouse and the evidence bucket, waits until they are healthy, then runs `scripts/apply-schemas.sh`. That applies every `infra/postgres/*.sql` and `infra/clickhouse/*.sql` file in name order. The files are idempotent; a fresh volume runs the same files from the database images.
4. Builds and starts `api` (the customer workspace and API), `backoffice` (the operator console), `browser-worker`, `posthog-worker`, the `browser-sandbox` replicas, `log-socket` and `log-collector` ([service logs](./logs.md)), and `edge` when asked. It does not start the one-shot `recorder`, the exploration fixture or the Larchwood shop.
5. On Linux, sets `SCOUT_DOCKER_GID` to the Docker socket's group so the log proxy can read it.

The first build compiles the Rust API and the browser image. The workspace is then at `http://127.0.0.1:18080` and the operator console at `http://127.0.0.1:18083`.

## Settings

| Setting | Where | Effect |
| --- | --- | --- |
| `SCOUT_PUBLISH` | Shell environment when running `just deploy` (the script exports `127.0.0.1` otherwise) | Workspace bind address. `0.0.0.0` publishes plain HTTP on every interface; refused while `SCOUT_DEV_AUTH_BYPASS=true` |
| `SCOUT_WORKSPACE_PORT`, `SCOUT_BACKOFFICE_PORT` | `.env` or environment | Host ports, default 18080 and 18083. The operator console always binds to loopback |
| `SCOUT_BROWSER_SLOTS` | `.env` | Concurrent browser runs and `browser-sandbox` replicas, 1–8, default 3 |
| `SCOUT_PUBLIC_HOST`, `SCOUT_PUBLIC_ORIGIN` | `.env` | Required for `edge`: the hostname, and the matching `https://` origin |
| `SCOUT_EDGE_TLS` | `.env` | `acme` (default, Let's Encrypt) or `origin` (Cloudflare Origin certificate) |
| `SCOUT_EDGE_CERT_DIR`, `SCOUT_BACKOFFICE_HOST` | `.env` | Required with `origin`: a folder holding `origin.pem`, `origin.key` and `aop-ca.pem`, and the operator console's hostname |
| `SCOUT_DEMO_SITES`, `SCOUT_DEMO_FIXED_HOST`, `SCOUT_DEMO_FAULTY_HOST` | `.env` | Publish the Larchwood demo shop (fixed and faulty) through the edge; `origin` mode only |
| `SCOUT_POSTHOG_DEMO_SITE`, `SCOUT_POSTHOG_DEMO_CERT_DIR`, `SCOUT_POSTHOG_DEMO_ENV_FILE` | `.env` | Publish the separate [PostHog demo](../../apps/posthog-demo/DEPLOY.md); `origin` mode only |

Other `.env` settings (provider keys, exploration defaults, sign-in) are listed in `.env.example`.

## Public HTTPS

`just deploy edge` refuses to run unless `SCOUT_PUBLIC_HOST` and an `https://` `SCOUT_PUBLIC_ORIGIN` are set, and while `SCOUT_DEV_AUTH_BYPASS=true`. A public origin also turns the development bypass off inside the API. Point DNS at the machine first.

- **`acme`**: Caddy (`infra/edge/Caddyfile`) serves `SCOUT_PUBLIC_HOST` and proxies to the API. The operator console is not published.
- **`origin`**: the script adds `compose.edge-origin.yaml`. Caddy (`infra/edge/Caddyfile.origin`) serves both the workspace and `SCOUT_BACKOFFICE_HOST` with the Cloudflare Origin certificate and requires Cloudflare's Authenticated Origin Pulls client certificate. Put the operator console behind Cloudflare Access; it still asks for the operator token.
- With `SCOUT_DEMO_SITES=true` the script adds `compose.demos.yaml`; with `SCOUT_POSTHOG_DEMO_SITE=true` it starts the separate demo project and adds `compose.posthog-demo-edge.yaml`, validating the Caddy configuration first.

## Database

The bundled PostgreSQL runs on the Compose network with `PGSSLMODE=disable`; the API logs a warning when that is combined with `SCOUT_PUBLIC_ORIGIN`. For a managed PostgreSQL server, use `PGSSLMODE=verify-full` (or `verify-ca`) with `PGSSLROOTCERT`, and optionally `PGSSLCERT`/`PGSSLKEY`; `allow` and `prefer` are rejected. `scripts/apply-schemas.sh` only applies schemas to the bundled database.

Each API process opens a read pool and a write pool (`SCOUT_DB_POOL_MAX`, default 8 each; `SCOUT_DB_READ_POOL_MAX` and `SCOUT_DB_WRITE_POOL_MAX` override one side) plus one connection for the model dispatcher lock. Keep `processes × (read + write + 1)` under the server's `max_connections`.

`GET /healthz` is an unauthenticated liveness check. `GET /readyz` (authenticated) fails while the database is unreachable or the model gateway is still starting.

## Limits of this setup

Compose runs everything on one host. The browser sandbox is container isolation on a shared kernel, not a virtual-machine boundary. ClickHouse is a single server. The evidence bucket is a local SeaweedFS volume, not an off-machine backup: back up the named volumes and `.env` together.
