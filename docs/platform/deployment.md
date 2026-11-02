# Local development and deployment

Decision updated 22 October 2026: **Rust/Axum API, TypeScript/Playwright worker, PostgreSQL, S3-compatible evidence storage, ClickHouse; Compose plus just locally.** OpenRouter is included alongside OpenAI and Claude. The bounded explorer now uses the gateway for planning, predictions and assessments.

## Local commands

The repository `justfile` wraps the existing scripts and Docker commands. It does not load or print `.env`; Compose and the local read helper resolve credentials privately. Install [just](https://just.systems/man/en/) on your PATH, or use this machine's checksum-verified local copy at `.tools/bin/just` (1.59.0).

```sh
just dev             # Build/start workspace/API, worker and storage; apply schemas
just reload          # Rebuild the workspace API and back office; leave databases and workers running
just reload-api      # Rebuild only the workspace API (it embeds apps/web)
just reload-backoffice # Rebuild only the operator console
just reload-env      # Recreate the API so it loads the current .env, without an image rebuild
just ui              # Start services and print the workspace URL
just workspace-test  # GUI API/queue/worker integration with simulated models
just web-test        # Pure rendering, usage and disconnect checks
just jobs            # Saved browser jobs and worker heartbeats
just operations      # Execution and evidence-export snapshot
just status          # Show health and ports
just demo            # Build recorder and run three controlled browser flows
just runs            # Read the latest runs through the Rust API
just run RUN_UUID    # Read one run, including evidence references
just api-test        # Rust handler/authentication tests
just models          # Configured providers, without exposing keys
just model-call request.json  # Admit a durable inference request
just model-request REQUEST_UUID # Inspect attempts, evidence and usage
just usage           # Per-user live usage; unknown values stay unknown
just model-test      # Fake providers, journal/outage/restart checks; restores normal mode
just runtime-test    # Chromium, storage, evidence failure and export tests
just explorer-test   # URL loop with simulated models, graph/evidence/usage verification
just fixture         # Start the controlled app; host preview on 127.0.0.1:18082
just explore URL     # Bounded exploration of a public https site or allowed app using configured models
just isolation-test  # Browser sandbox: no credentials or storage network, Chromium sandbox, one run per container
just explore-matrix URL # Desktop, tablet and mobile runs at once, one browser slot each
just graph RUN_UUID  # Inspect states, edges, frontier and model decisions
just test            # Core tests; model-test is separate because it restarts services
just stop            # Stop services while keeping named volumes
```

`just demo` and `just runtime-test` assume `just dev` has prepared the data services. Recovery and pending-export commands are also listed by `just --list`. Native Rust checks use Cargo; the normal container build runs the Rust tests and produces a release binary. Node.js 22+ remains required for the local utility scripts. The API does not run Node.

Published service ports bind to host loopback unless a deploy sets `SCOUT_PUBLISH`. The API is at `http://127.0.0.1:18080`, S3 at `http://127.0.0.1:18333`, and ClickHouse at `http://127.0.0.1:18123`. PostgreSQL is reachable only inside Compose. The API token is generated once in the private `.env`; `just runs` uses it without echoing it. No model key is required for fixture testing.

The API has a persistent `gateway-spool` volume for response journals. Provider API keys are optional private `.env` entries; they go only to the Rust service. The browser worker receives a local API token, not provider credentials. Chromium runs in the separate `browser-sandbox` service, which receives no credentials or volumes and is attached only to the browser network; see [URL exploration](../exploration/overview.md). The explicit model test overlay adds a local fake-provider server on loopback port 18081 and ignores real keys. Its cleanup removes that test container and restores normal gateway configuration. Explorer tests additionally leave a controlled target on loopback port 18082. See [model gateway](./model-gateway.md) and [URL exploration](../exploration/overview.md).

## Deploy on one machine

`just deploy` starts the customer workspace and its API, the operator console, the browser worker and sandboxes, PostgreSQL, ClickHouse, and the private evidence bucket. It does not start the one-shot recorder or the exploration fixture. Database host ports stay on loopback. The operator console stays on loopback. The workspace bind address defaults to loopback too.

```sh
just deploy
```

The command preserves or creates private credentials in `.env`, builds the images, waits until PostgreSQL, ClickHouse and the evidence service are healthy, then applies every `infra/postgres/*.sql` and `infra/clickhouse/*.sql` file in name order. Those statements are idempotent. A later deploy updates an existing volume; a fresh volume also runs the same files from the database images. Node is used for credential setup when it is installed. Without Node, OpenSSL creates the same private `.env`.

Open the workspace at `http://127.0.0.1:18080` and the operator console at `http://127.0.0.1:18083`. `just deploy-stop` stops the containers, including the HTTPS proxy if it was started, and keeps the volumes.

`SCOUT_PUBLISH=0.0.0.0` publishes the workspace on every interface as plain HTTP. Deploy refuses that bind while `SCOUT_DEV_AUTH_BYPASS=true`. `SCOUT_WORKSPACE_PORT` and `SCOUT_BACKOFFICE_PORT` change the host ports (defaults 18080 and 18083).

For a public HTTPS name, set `SCOUT_PUBLIC_HOST` to the hostname and `SCOUT_PUBLIC_ORIGIN` to the `https://` origin, point DNS at this machine, and run `just deploy edge`. Caddy listens on ports 80 and 443 and proxies to the API. The workspace port and the operator console stay on loopback; deploy refuses the edge while `SCOUT_DEV_AUTH_BYPASS=true`. A public origin disables the development auth bypass. Bundled Postgres still uses `PGSSLMODE=disable` on the Compose network, and the API logs a warning; use `verify-full` when Postgres is a managed server on a network you do not trust. Bundled ClickHouse is one server. This command does not apply the schema to an external database.

### Hetzner and Cloudflare

[infra/deploy](../../infra/deploy/README.md) runs this same command on a Hetzner CX43 (Debian 13) behind a proxied Cloudflare zone. The customer workspace is at `app.spekios.com`, and the operator console is at `bo.spekios.com` behind Cloudflare Access. Terraform creates:

- the server;
- a cloud firewall (443 and 80 from Cloudflare only, 22 from admin addresses);
- the DNS records;
- a Cloudflare Origin certificate;
- Authenticated Origin Pulls with a private CA;
- the Access application;
- a Cloudflare Tunnel to sshd, which only the GitHub deploy service token can use, so port 22 stays closed to GitHub.

Ansible hardens the host and refuses kernels without recorded fixes. It then deploys a committed revision with `SCOUT_EDGE_TLS=origin`, which makes `scripts/deploy.sh` add `compose.edge-origin.yaml`. Caddy then serves both hostnames with the Origin certificate and requires Cloudflare's client certificate, instead of requesting certificates from Let's Encrypt. Use `just cloud-plan`, `just cloud-apply` and `just cloud-deploy`. After `just cloud-ci-setup`, every push to the `prod` branch deploys through GitHub Actions, and `just release` pushes the commit you have checked out to `prod`. See [Releasing](../../infra/deploy/README.md#releasing).

## Why Compose first

For this one-machine phase, Compose describes the processes, health checks, resource caps, network and volumes without an additional cluster. `just` makes the common workflow one command while preserving the underlying scripts. This is a development choice. The browser sandbox is container isolation on one shared host kernel, not a virtual-machine or multi-tenant boundary.

Kubernetes is useful when we need deployment parity, independently scheduled workers, rollout controls or several hosts. It also requires decisions about cluster networking, persistent storage, ingress, secrets and operations. Switching now would not improve browser or model-call latency. The recommendation is to keep the verified Compose loop and add Kubernetes parity once the worker/API boundary and isolation contract are stable. [Compose application model](https://docs.docker.com/compose/intro/compose-application-model/), [kind local clusters](https://kind.sigs.k8s.io/docs/user/quick-start/)

## Kubernetes implementation gate

This is the agreed deployment direction, **not a claim that a Kubernetes cluster or manifests have been implemented**:

| Component | Kubernetes form | Verification required |
| --- | --- | --- |
| Rust API / controller | Separate Deployments and Services | Readiness, graceful drain, restart/reconciliation, authenticated worker calls |
| Browser attempts | Bounded Jobs with isolated credentials and egress | Resource limits, cancellation, lost-worker recovery, no unrecorded target actions |
| PostgreSQL / ClickHouse | Persistent development services; managed or operated deployments for production | Backup/restore, schema migration, usage/outbox replay |
| Evidence | S3-compatible development service; durable S3 provider in deployment | Existing IDs/hashes preserved, scoped access, retention and restore |
| Configuration/secrets | ConfigMaps plus a chosen secret-management mechanism | No keys in images, logs, model context or ordinary manifests |

Each API replica opens its own read pool and write pool (`SCOUT_DB_POOL_MAX`, default 8 each). Size `replicas * (read + write) + 1` under the server `max_connections`; the extra connection is the model dispatcher lock and is not taken from the pools. Liveness is `GET /healthz`. Readiness is `GET /readyz`: it fails while Postgres is unreachable or this process is still starting, and it stays open for replicas that are waiting on another dispatcher. A dropped database connection is replaced by the pool. Set `PGSSLMODE=verify-full` and mount `PGSSLROOTCERT` for a managed database; `disable` is the local Compose setting. `PGSSLMODE=require` encrypts without checking the server certificate. Client certificates are `PGSSLCERT` and `PGSSLKEY`. Workspace tabs send `If-None-Match` for an open run so an unchanged report is not rebuilt.

Start parity testing with a dedicated kind cluster, using the same images and explicit context/namespace. A CNI capable of enforcing the chosen network policies is required; the presence of a NetworkPolicy resource alone is insufficient. Worker restrictions must be tested against metadata endpoints, private services, redirects and alternative transports before arbitrary targets are enabled.

Do not treat Compose volumes as Kubernetes volumes. Export/restore database data and evidence explicitly, verify manifests and checksums, then compare recorded-action and usage-replay results. Keep the existing local bucket until migration and restore checks pass. Deleting a local cluster must never be the only way to preserve or recover training evidence.

No Helm chart, operator or Kubernetes daemon has been installed for this increment. The next deployment work should follow a functioning provider gateway and an isolated worker protocol, not block those features.
