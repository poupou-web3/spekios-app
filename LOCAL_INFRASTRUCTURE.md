# Local infrastructure: implemented and verified

Verified on 22 October 2026 in `/Users/runnr/Documents/front`. Rust and three storage services run through `just dev`. The seven supplied screenshots retain stable UUIDs, hashes, metadata and ClickHouse events. A Chromium recorder stores predictions, captures, differences and fixture assessments. The Rust gateway now records model attempts, payloads and usage with recovery and S3/ClickHouse export.

The API now serves the [user workspace and operations console](./WORKSPACE_UI.md) and submits durable browser jobs to a background worker. Both the GUI and `explore URL` CLI perform bounded planning, prediction and assessment through the gateway and record a flow graph. Fresh-browser reproduction uses separate evidence. OpenAI/Claude/OpenRouter integration is tested with local fake providers; no live account was used. Subscription auth, monetary budgets, arbitrary-site isolation, access handoff and parallel workers remain to build. Schemas cover reference evidence, browser runtime, model calls, exploration graphs, reproduction, jobs and worker heartbeats. See [URL exploration](./EXPLORATION.md).

## Start the services

Requires Docker with Compose and Node.js 22 or newer. From the repository directory:

```sh
bash scripts/start-local.sh
```

This preserves or creates private credentials, installs pinned utilities, builds/starts services, applies archive/runtime/model schemas, and waits for gateway readiness. `just dev` uses the same workflow. Initial setup needs network access for packages/images. Credentials live in ignored `.env` with mode `0600` and are not printed. Preserve it alongside the volumes. Changing passwords in this file does not rotate credentials already stored in PostgreSQL.

| Service | Version | Host access | Persistent volume | Container cap |
| --- | --- | --- | --- | --- |
| Rust API | Axum 0.8.9; Rust 1.91 container build | `http://127.0.0.1:18080` | `scout-qa_gateway-spool` response journals; PostgreSQL state | 256 MiB, 1 CPU |
| SeaweedFS S3 | 4.48 | `http://127.0.0.1:18333` | `scout-qa_evidence-data` | 1 GiB, 1 CPU |
| PostgreSQL | 17.11 | Compose network only; no host port | `scout-qa_postgres-data` | 512 MiB, 1 CPU |
| ClickHouse | 26.7.35.11 | `http://127.0.0.1:18123` | `scout-qa_clickhouse-data` | 2 GiB, 2 CPUs |
| Recorder, one-shot `runtime` profile | Playwright/Chromium 1.64.0 image | No published port | `scout-qa_recorder-spool` | 1 GiB, 2 CPUs |
| Background browser worker | Same recorder image, queue daemon | No published port | Shared recorder spool; PostgreSQL jobs | 1 GiB, 2 CPUs |

Images are pinned by digest in Compose or the service Dockerfiles. PostgreSQL and ClickHouse use small derived images containing their initialization/configuration files, so startup does not depend on Docker Desktop reading bind mounts from macOS Documents. Application builds copy explicit source files; `.dockerignore` excludes `.env`, artifacts, dependency/build directories and local tools. ClickHouse listens on the container interface while Compose publishes it on host loopback only; query threads and server memory are separately limited. The global thread-pool ceiling leaves enough room for background work and table initialization.

No Redis, Kubernetes cluster or OpenTelemetry collector is installed. ClickHouse receives archive, browser and model events through durable PostgreSQL outboxes. Model bodies are uploaded to S3 with hash verification. Kubernetes follows stable service/isolation boundaries; see [development and deployment](./DEPLOYMENT_AND_DEVELOPMENT.md).

## Screenshot archive

Bucket: **`qa-evidence`**. Archive ID: **`15cd1da9-d8c4-4f26-b8b4-9b4ebae6481f`**.

The [local manifest](./artifacts/reference-screenshots/manifest.json) lists all seven capture IDs, SHA256 hashes, filenames, byte lengths and object keys. The original PNGs total **2,568,363 bytes** (2.57 MB decimal). The bucket contains 15 archive objects: seven original blobs, seven capture-ID records, and one manifest. This size describes these references, not a forecast of browser-run storage.

```text
design-reference/blobs/sha256/<prefix>/<sha256>.png
design-reference/captures/<capture_id>.json
design-reference/archives/<archive_id>/manifest.json
```

Capture IDs identify occurrences; SHA256 identifies original encoded bytes. An unchanged image can therefore be referenced by distinct future capture IDs without requiring duplicate blob storage. The reference screenshots are labeled `purpose: design_reference` and `training_status: excluded_reference`; they are not represented as executed browser actions or training examples.

To archive or verify the source files again:

```sh
node scripts/archive-reference-screenshots.mjs
node scripts/verify-local.mjs
```

The source list in `scripts/reference-sources.json` refers to this task's original attachments. On another machine, supply paths to the same byte-identical files under the same filenames. The saved manifest preserves IDs across reruns; changed inputs are rejected. A failed export leaves committed rows in PostgreSQL for retry.

Retrieve one screenshot by its capture ID, without needing its original attachment path:

```sh
node scripts/get-reference-capture.mjs 15412f53-4ffe-47d3-bb13-49035ac513cc /tmp/scout-first-capture.png
```

The destination must be a new file. Retrieval resolves the capture record in S3, verifies its classification and checksum, then writes with mode `0600`. No public object URL is created. Anonymous object requests were verified to return HTTP 403.

Uploads use conditional creation and verify bytes by reading them back. An existing object with different contents is rejected. Capture metadata and immutable export events commit together in PostgreSQL. ClickHouse queries use `scout.evidence_events_current`, which deduplicates repeated deliveries by event ID. Its raw table can contain delivery duplicates; use the view for logical counts.

## Verification results

All of these checks passed:

- Seven distinct capture IDs; every original image and capture record resolves with the expected SHA256 and size.
- Seven PostgreSQL captures/blobs/outbox events; zero pending exports; seven logical ClickHouse events.
- Repeating the archive command preserves IDs and creates no new logical events.
- Recreating all three containers without deleting volumes preserves the objects and database records.
- S3 conditional creation rejects a conflicting write; anonymous access is denied.
- A simulated exporter outage retains the pending event. Retrying delivery restores the projection without inflating logical counts.
- Capture-ID retrieval reproduces the exact original bytes and refuses to overwrite an existing local file.
- Seven archive-client tests and eleven image-difference tests pass.

Reproduce the automated checks:

```sh
npm test --prefix scripts
node scripts/verify-local.mjs
node scripts/verify-recovery.mjs
npm ci --prefix packages/image-diff --ignore-scripts
npm test --prefix packages/image-diff
```

The recovery test writes and removes one uniquely named probe object and replays one real archive event. It does not delete screenshot evidence. The archive verifier currently targets this seven-file reference archive; it is not a general browser-run verifier.

The [image-difference module](./packages/image-diff/README.md) produces a raw absolute RGBA delta, an opaque binary mask, optional geometry mask, and metadata linked to the two capture IDs. Tests include a one-value change in one pixel, alpha changes, identical pixels with different PNG encodings, dimension changes, invalid inputs, and overwrite refusal. A single local smoke measurement comparing a 3004×1630 reference PNG to itself, including decode and derivative encoding, took about 0.5 seconds; this is not a production performance benchmark. The module produces evidence; the recorder separately assigns a deterministic fixture assessment.

## Browser recorder and Rust API verification

All 12 recorder tests passed in the browser increment. Rust tests now include provider/usage checks alongside auth/handler coverage; static checks pass with warnings treated as errors. The API verifier checks real recorder data and workspace scope. The model suite passed 19 requests, 20 attempts and 59 events; a separate journal test verifies recovery after settlement failure without redispatch or double accounting. These tests use fake providers. See [gateway verification](./MODEL_GATEWAY.md).

The URL-explorer integration also passed with real browser/storage services and simulated providers. Its saved demonstration records 5 actions, 10 screenshots, 4 states, 10 model requests, hash-verified payloads and ClickHouse export. The older recorder and gateway outage/recovery suites passed again after integration. See [exploration verification](./artifacts/explorer/verification.json) and [run instructions](./EXPLORATION.md).

The [saved demo report](./artifacts/runtime-demo/results.json) contains three real browser flows, with two actions/four unique capture occurrences per flow. Its click results are: working control — 361 changed pixels and expected value observed; broken control — zero changed pixels and suspect; tiny control — one changed pixel and expected value observed. No model made these judgments, and no bug is marked confirmed.

Runtime screenshot IDs resolve to immutable S3 capture records, with hash-addressed image blobs and run/action/phase relationships. Captures are spooled durably before upload; failures stop advancement and remain visible. Interrupted dispatch recovery does not repeat the action. Events use stable IDs and a deduplicated ClickHouse view. Fixture captures are labeled `excluded_fixture`, and video remains disabled. Full instructions: [recorder](./packages/browser-runtime/README.md), [Rust API](./apps/api/README.md).

## Persistence and next integration

Use `docker compose stop` when idle and the startup command to resume. Retain the named volumes and `.env`; removing volumes deletes the stored evidence/databases. This is a private **local bucket**, not a remote cloud backup. An off-machine backup and restore test have not been configured. There is no automatic evidence expiry.

Model predictions/assessments, bounded URL-only exploration and independent reproduction run through the recorder and queued worker. The recorder still needs a scoped worker protocol and enforced network isolation before arbitrary apps are admitted. Live-provider quality verification, access handoff and subscription authentication remain outstanding; API-key configuration is available now. GUI job/evidence integration passed; visual browser interaction remains unverified after a computer-use restriction.
