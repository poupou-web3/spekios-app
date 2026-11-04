---
{
  "title": "How the services fit together",
  "description": "Understand Spekios’s Rust API, browser worker, browser sandbox, model gateway, PostgreSQL, S3-compatible evidence store and ClickHouse outbox architecture.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 1
  }
}
---
Spekios separates browser execution, authoritative records, evidence bytes and analytical delivery. The local Compose stack runs these services on one machine.

## Execution path

1. The workspace, MCP bridge or HTTP client submits a command to the Rust API.
2. The API validates scope, target URL, provider and command identity, freezes the effective settings and stores a durable job in PostgreSQL.
3. The browser worker claims work and drives Chromium in the browser sandbox using typed Playwright operations.
4. Planning and assessment requests go through the Rust model gateway.
5. The recorder stores action records and evidence, then exports durable events through outboxes.
6. Clients read progress and reports from recorded state.

## Service responsibilities

| Service | Responsibility |
| --- | --- |
| Rust/Axum API | Serves the workspace; authentication, admission, model gateway, read projections, evidence access and agent adapters. |
| Back office | Separate operator console (nginx) on a loopback port; proxies the API with the operator token. |
| TypeScript/Playwright worker | Observation, browser actions, planner loop, completion sampling, replay and private human handoff. Holds storage credentials and the saved-login vault. |
| Browser sandbox | Runs Chromium for every target page, with no Spekios credentials or storage network. Restarts after each run. See [access and recording boundaries](../security/). |
| PostgreSQL | Authoritative jobs, runs, actions, settings, review history, model requests and outbox state. |
| SeaweedFS S3 | Private screenshot/artifact and model-payload objects in the qa-evidence bucket. |
| ClickHouse | Analytical runtime/model/review events delivered from durable records, plus container logs shipped by the log collector for the back office. |
| Static docs | Public product/integration guidance, machine-readable files and local search; no connection to live evidence. |

## Why this split

Rust handles admission and gateway I/O without making the browser runtime depend on Node API infrastructure. Playwright remains in TypeScript for browser integration.

PostgreSQL coordinates durable commands and revisions. S3 stores large bytes. ClickHouse supports observability without becoming the transaction authority for job state.

A ClickHouse delivery outage leaves pending outbox state. It does not justify losing an action record or pretending an undelivered event was never created.

## Current deployment model

The browser worker runs up to `SCOUT_BROWSER_SLOTS` jobs at once (1–8). Compose starts one sandbox container per slot; each serves one run and then restarts. A running job holds a Postgres advisory lock that disappears with its connection, so a crashed job is detected immediately and marked interrupted with its evidence preserved. It is not resumed automatically and no dispatched action is repeated; a person can choose **Continue exploration**. Jobs are claimed for every workspace member. Kubernetes deployment manifests are not implemented.

Compose is the supported setup, on one machine. `just deploy` runs it on a host, and `just deploy edge` adds a Caddy HTTPS proxy; see [Run Spekios locally](../../getting-started/local-setup/#deploy-this-stack-on-a-host). The public docs can be deployed as a standalone static site independently of the backend.
