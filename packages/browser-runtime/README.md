# Browser runtime

The TypeScript/Playwright side of Spekios: everything that drives a real Chromium against a target site and records evidence. One package and one image (`infra/recorder/Dockerfile`, `scout-qa-recorder:local`) provide several Compose services:

| Entry point | Compose service | Role |
| --- | --- | --- |
| `src/worker.ts` | `browser-worker` | Claims browser jobs (explore, reproduce, verify fix) from PostgreSQL, runs up to `SCOUT_BROWSER_SLOTS` at once, holds saved sign-in sessions |
| `src/browser-server.ts` | `browser-sandbox` (replicas = slots) | Runs Chromium for target sites with no Spekios credentials, volumes or storage network; one run per container, then restarts |
| `src/posthog-worker.ts` | `posthog-worker` | Imports PostHog recordings and turns them into browser workflows |
| `src/cli.ts` | `recorder` (`runtime` profile, one-shot) | Commands below |
| `src/fixture-cli.ts` | `exploration-fixture` | A controlled test app on port 8082 |

How it connects: the worker reads and writes PostgreSQL directly (job queue, runs, actions, events, outboxes), writes screenshots and derivatives to the S3-compatible `qa-evidence` bucket, exports events to ClickHouse from a durable outbox, and sends every model request through the API's gateway (`SCOUT_API_URL`, `/v1/model-requests`). It drives Chromium in `browser-sandbox` over `SCOUT_BROWSER_ENDPOINT` and refuses to start without it. Screenshot comparison uses [`packages/image-diff`](../image-diff/README.md).

Main modules: `explorer.ts` (exploration loop), `frontier-planner.ts` and `exploration-strategy.ts` (what to try next), `interaction-contract.ts` / `browser-interactions.ts` (typed actions), `recorder.ts` and `store.ts` (evidence and persistence), `reproduction.ts`, `automatic-reproduction.ts`, `fix-verification.ts`, `access-*.ts` and `auth-session.ts` (private sign-in), `app-memory.ts`, `steering.ts`, `computer-use.ts`.

## Commands

From the repository root, with the stack up (`just up`):

```sh
just build-recorder          # build the image
just demo                    # three fixed fixture flows: working, broken and one-pixel change
just explore URL             # one exploration
just explore-matrix URL      # desktop, tablet and mobile at once
just reproduce ACTION_ID     # replay a suspect action in a fresh browser
just recover RUN_ID          # retry interrupted uploads and republish the manifest
just flush                   # export pending events to ClickHouse
docker compose run --rm --no-deps recorder show RUN_ID
docker compose run -T --rm --no-deps recorder capture CAPTURE_ID > new-file.png
```

The workspace and API normally queue explorations for `browser-worker` instead; the `recorder` commands are for development. `explore` and `reproduce` use the model configured by `SCOUT_EXPLORER_*` and allowed origins from `SCOUT_ALLOWED_ORIGINS`.

## Evidence

Every action records a prediction before dispatch, before and after screenshots (lossless PNG) with page observations, a pixel comparison and an assessment (`no_issue_observed`, `suspect` or `inconclusive`). Nothing is marked a confirmed bug automatically. Bucket layout:

```text
workspace/<workspace_id>/captures/<capture_id>.json
workspace/<workspace_id>/blobs/sha256/<sha256>.png
```

Bytes are spooled locally (`recorder-spool` volume) before upload so `recover` can finish interrupted uploads; interrupted actions are recorded as unknown outcomes and never repeated. The spool and bucket have no automatic expiry yet. In ClickHouse, query `scout.runtime_events_current` for logical event counts, since raw deliveries can repeat. Details: [browser runtime](../../docs/runtime/browser.md), [evidence](../../docs/runtime/evidence.md), [exploration](../../docs/exploration/overview.md), [planner](../../docs/exploration/planner.md), [reproduction](../../docs/exploration/reproduction.md).

Navigation stays on the entry site (its registered domain and subdomains). Private, loopback and link-local hosts are blocked unless listed in `SCOUT_ALLOWED_ORIGINS`. Popups, dialogs and downloads are outside the supported action contract.

## Test

```sh
just runtime-test   # tsc --noEmit, then the tsx test suite in the recorder container
```

Tests use real Chromium, PostgreSQL, the bucket and ClickHouse with simulated model providers; they need the stack running and keep their fixture evidence. Focused suites run through `scripts/test-explorer.sh`, for example `just explorer-test`, `just outcomes-test`, `just access-test` and `just steering-test`.

`evaluation/` holds the [Larchwood visual-assessment evaluation](evaluation/README.md).
