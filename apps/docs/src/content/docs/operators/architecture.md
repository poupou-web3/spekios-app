---
{
  "title": "How the services fit together",
  "description": "Understand ScoutQA’s Rust API, browser worker, browser sandbox, model gateway, PostgreSQL, S3-compatible evidence store and ClickHouse outbox architecture.",
  "reviewed": "2026-10-30",
  "sidebar": {
    "order": 1
  }
}
---
Scout separates browser execution, authoritative records, evidence bytes and analytical delivery. The local Compose stack runs these services on one machine.

## Execution path

1. The workspace, MCP bridge or HTTP client submits a command to the Rust API.
2. The API validates scope, origin, provider and command identity, then stores a durable job in PostgreSQL.
3. The browser worker claims work and drives Chromium in the browser sandbox using typed Playwright operations.
4. Planning and assessment requests go through the Rust model gateway.
5. The recorder stores action records and evidence, then exports durable events through outboxes.
6. Clients read progress and reports from recorded state.

## Service responsibilities

| Service | Responsibility |
| --- | --- |
| Rust/Axum API | Authentication, admission, model gateway, read projections, evidence access and agent adapters. |
| TypeScript/Playwright worker | Observation, browser actions, planner loop, completion sampling, replay and private human handoff. Holds storage credentials and the saved-login vault. |
| Browser sandbox | Runs Chromium for every target page, with no Scout credentials or storage network. Restarts after each run. See [access and recording boundaries](../security/). |
| PostgreSQL | Authoritative jobs, runs, actions, settings, review history, model requests and outbox state. |
| SeaweedFS S3 | Private screenshot/artifact and model-payload objects in the qa-evidence bucket. |
| ClickHouse | Analytical runtime/model/review events delivered from durable records. |
| Static docs | Public product/integration guidance, machine-readable files and local search; no connection to live evidence. |

## Why this split

Rust handles admission and gateway I/O without making the browser runtime depend on Node API infrastructure. Playwright remains in TypeScript for browser integration.

PostgreSQL coordinates durable commands and revisions. S3 stores large bytes. ClickHouse supports observability without becoming the transaction authority for job state.

A ClickHouse delivery outage leaves pending outbox state. It does not justify losing an action record or pretending an undelivered event was never created.

## Current deployment model

There is one browser worker, guarded by the existing ownership/advisory-lock protocol, and one browser sandbox, which serves one run at a time. Multi-worker scheduling and Kubernetes deployment manifests are not implemented.

Compose is the supported one-machine development setup. The public docs can be deployed as a standalone static site while the backend remains local.
