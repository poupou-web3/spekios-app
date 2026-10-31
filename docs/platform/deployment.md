# Local development and deployment

Decision updated 22 October 2026: **Rust/Axum API, TypeScript/Playwright worker, PostgreSQL, S3-compatible evidence storage, ClickHouse; Compose plus just locally.** OpenRouter is included alongside OpenAI and Claude. The bounded explorer now uses the gateway for planning, predictions and assessments.

## Local commands

The repository `justfile` wraps the existing scripts and Docker commands. It does not load or print `.env`; Compose and the local read helper resolve credentials privately. Install [just](https://just.systems/man/en/) on your PATH, or use this machine's checksum-verified local copy at `.tools/bin/just` (1.59.0).

```sh
just dev             # Build/start workspace/API, worker and storage; apply schemas
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

All published service ports bind to host loopback. The API is at `http://127.0.0.1:18080`, S3 at `http://127.0.0.1:18333`, and ClickHouse at `http://127.0.0.1:18123`. PostgreSQL is reachable only inside Compose. The API token is generated once in the private `.env`; `just runs` uses it without echoing it. No model key is required for fixture testing.

The API has a persistent `gateway-spool` volume for response journals. Provider API keys are optional private `.env` entries; they go only to the Rust service. The browser worker receives a local API token, not provider credentials. Chromium runs in the separate `browser-sandbox` service, which receives no credentials or volumes and is attached only to the browser network; see [URL exploration](../exploration/overview.md). The explicit model test overlay adds a local fake-provider server on loopback port 18081 and ignores real keys. Its cleanup removes that test container and restores normal gateway configuration. Explorer tests additionally leave a controlled target on loopback port 18082. See [model gateway](./model-gateway.md) and [URL exploration](../exploration/overview.md).

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

Start parity testing with a dedicated kind cluster, using the same images and explicit context/namespace. A CNI capable of enforcing the chosen network policies is required; the presence of a NetworkPolicy resource alone is insufficient. Worker restrictions must be tested against metadata endpoints, private services, redirects and alternative transports before arbitrary targets are enabled.

Do not treat Compose volumes as Kubernetes volumes. Export/restore database data and evidence explicitly, verify manifests and checksums, then compare recorded-action and usage-replay results. Keep the existing local bucket until migration and restore checks pass. Deleting a local cluster must never be the only way to preserve or recover training evidence.

No Helm chart, operator or Kubernetes daemon has been installed for this increment. The next deployment work should follow a functioning provider gateway and an isolated worker protocol, not block those features.
