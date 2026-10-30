# Recorded browser actions

Three entry points share the evidence recorder: `demo` runs deterministic `fixture_defined` cases; `explore URL` connects the Rust model gateway to bounded planning, predictions and assessments; `reproduce ACTION_UUID` replays a suspect explorer action's path in a fresh browser with separate evidence. All persist real Chromium evidence in the Compose stack. See [URL exploration](../../docs/exploration/overview.md) and [reproduction](../../docs/exploration/reproduction.md) for configuration, verification and limits. The sections below describe the deterministic recorder baseline.

The explorer now uses [frontier planning](../../docs/exploration/planner.md) to rank known paths, prioritize changed clickable controls, return to branches and replan stale screens. `explore-matrix URL` runs the three responsive viewport profiles sequentially with separate evidence and usage. These capabilities extend the explorer; the fixed recorder demo below is unchanged.

## Run locally

From the repository root, with Docker and Node.js 22 or newer:

```sh
bash scripts/start-local.sh
docker compose build recorder
docker compose run --rm --no-deps recorder demo
```

The demo runs three separate flows: a working Save button, a broken Save button, and a one-pixel change. It prints run/action/prediction/capture IDs, the changed-pixel count, each assessment, and a private bucket manifest key. It exits unsuccessfully if execution, manifest storage, or telemetry export fails. A completed run can contain a `suspect` assessment: execution completion and product correctness are separate facts.

The `recorder` service is a one-shot container behind the `runtime` Compose profile. Ordinary stack startup runs the Rust API and three storage services. Each recorder uses one Chromium instance, up to ten actions, an 800×600 viewport, and device scale 1. Its container has a 1 GiB memory limit, two CPUs, a read-only root filesystem, temporary browser storage, and a persistent evidence spool. The first image download includes the browsers and can take several minutes.

## What an action records

1. A unique action ID and prediction ID, with the expected result committed before dispatch.
2. A unique before-capture ID, original lossless PNG, and page observation.
3. Dispatch state and bounded tool error, when present.
4. A unique after-capture ID, PNG, and observation, including after a tool timeout when the page remains available.
5. An exact pixel mask, absolute channel delta, comparison ID, and derivative artifact references.
6. An assessment with expected and observed values: `no_issue_observed`, `suspect`, or `inconclusive`.

A one-value change in one channel of one pixel survives the comparison. An empty difference mask still receives an assessment; a broken button is not passed because nothing changed. These deterministic checks only evaluate the specific frozen fixture expectation. They do not certify that a page has no other bugs. All assessments have `confirmed_bug: false`; the fresh-browser reproduction command applies to model-driven explorer suspects and still requires review.

Screenshots and DOM observations are sampled sequentially, not atomically. Separate timestamps record that boundary. Page text is a bounded 8,000-character preview with an explicit truncation flag. An observation failure preserves any successfully captured image and prevents a passing assessment. Before-capture failure prevents dispatch; after-capture failure stops further actions and records an evidence gap.

Video recording is disabled. This increment records viewport screenshots and action evidence; complete network/console traces, full DOM snapshots, streaming replay, and continuous intermediate frames remain later work.

## Evidence, IDs, and recovery

Every capture occurrence has its own UUID, even when its PNG is identical to another capture. SHA256-addressed blobs deduplicate identical encoded bytes within the local workspace. Capture records include run/action/phase relationships, observation timestamps, checksums, and `training_status: excluded_fixture`. Fixture records and the supplied design references are excluded from future training exports by default.

Private bucket `qa-evidence`:

```text
workspace/<workspace_id>/captures/<capture_id>.json
workspace/<workspace_id>/blobs/sha256/<sha256>.png
workspace/<workspace_id>/blobs/sha256/<sha256>.json
```

Uploads use conditional creation and verified readback. The run manifest contains ordered actions, predictions, assessments, capture records, events, derivative references, and any exploration graph/model-call lineage. PostgreSQL owns execution state and the upload journal; ClickHouse receives ordered events from a durable outbox in batches of at most 100. Query `scout.runtime_events_current` for logical event counts, since raw deliveries can repeat. Fixture demos without model requests report `not_connected`; explorer manifests include token totals, missing usage, pending requests and payload references.

Inspect a run, retrieve an image by capture ID, or retry interrupted evidence/export work:

```sh
docker compose run --rm --no-deps recorder show <run-uuid>
docker compose run -T --rm --no-deps recorder capture <capture-uuid> > /tmp/capture.png
docker compose run --rm --no-deps recorder recover <run-uuid>
docker compose run --rm --no-deps recorder flush
```

Replace the angle-bracket placeholders with IDs printed by the demo. Use a fresh destination when redirecting an image; shell redirection can overwrite an existing file. Capture retrieval checks ownership, availability, size, and hash before emitting PNG bytes.

The `scout-qa_recorder-spool` volume retains durable capture/derivative bytes and capture metadata for upload recovery. A PostgreSQL advisory lock allows only one recording/recovery operation across this local stack. Interrupted dispatched actions are marked as unknown outcomes and never automatically repeated. Recovery retries immutable uploads and republishes the manifest; it cannot manufacture a missing screenshot or convert an interrupted action into a successful assessment. Pending export acknowledgments survive a ClickHouse outage. The spool and bucket currently have no automatic expiry or garbage collection.

## Verification

```sh
docker compose run --rm --no-deps --entrypoint npm recorder run check
docker compose run --rm --no-deps --entrypoint npm recorder test
```

Integration tests use the real browser, PostgreSQL, bucket, and ClickHouse. They exercise working, broken, one-pixel, timeout, missing-capture, and failed-observation flows; byte-verified capture-ID retrieval; upload recovery; and replay without inflated logical event counts. The interruption test seeds a dispatched action in PostgreSQL and verifies recovery behavior; it is not a process-kill durability test. Tests retain their evidence with the fixture exclusion label.

Verified on 21 October 2026: all 12 tests passed. The [saved demo](../../artifacts/runtime-demo/results.json) records a working button with 361 changed pixels, a broken button with zero changes and a suspect assessment, and a one-pixel change with channel delta 1. These are fixture results, not a model-quality benchmark.

## Next boundary

This is a single-user development harness with fixed local workspace/user IDs, not an authenticated API. The browser may load the entry origin plus public HTTPS subresources and public secure websockets, including sibling APIs, fonts and hosted backends. Top-level navigation stays on the entry origin. Private, loopback, link-local and credentialed hosts stay blocked; an allowlisted page may call another allowlisted origin, and a public page does not inherit that list. Explorations, reproductions and fix checks run Chromium in the `browser-sandbox` container through `SCOUT_BROWSER_ENDPOINT` ([browser-sandbox.ts](src/browser-sandbox.ts), [browser-server.ts](src/browser-server.ts)). It has no Scout credentials, volumes or storage network, runs Chromium's own sandbox and serves one connection before restarting. Without an endpoint, Chromium launches locally: the demo recorder and in-process test fixtures use that, and the queued worker refuses to start. Popups, dialogs and downloads stay outside the supported action contract.

The [Rust model gateway](../../docs/platform/model-gateway.md) now feeds model predictions and assessments to `explore URL`, with separate assessments for `reproduce ACTION_UUID`. Integration tests use local provider fixtures; live-model quality is unverified. Reviewed confirmation and a credential-free worker protocol remain next boundaries. The deterministic `demo` remains available for evidence-pipeline regression checks.

Browser/package versions are pinned together using the [official Playwright container guidance](https://playwright.dev/docs/docker). Capture settings preserve animations and the caret rather than silently modifying the page for a prettier screenshot; [Playwright screenshot options](https://playwright.dev/docs/api/class-page#page-screenshot).
