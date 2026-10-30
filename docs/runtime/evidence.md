# Evidence and training-data contract

Portable [run reports](./reports.md) now provide Markdown/JSON and verified evidence ZIP downloads. Their export UUID and file hashes identify a selected-run snapshot; failed or missing evidence remains in the manifest as a gap. This is a local inspection report, not the training dataset export described below: `training_approval` remains false, fixture exclusions remain intact, and no data is uploaded to a model or training service.

Implemented review labels: [finding reviews](../exploration/finding-reviews.md) now persist a review UUID, revision, human rationale, expectation basis, severity and evidence snapshot separately from model judgments. Confirmed reviews retain the original training classification; dataset approval and export remain future work.

Updated 21 October 2026. This specification extends the browser runtime for the requested local Docker Compose application; [Local infrastructure](../platform/infrastructure.md) records which services and reference artifacts actually exist. Provisioning storage is distinct from implementing this browser evidence contract or producing a training dataset. A URL is sufficient to begin a run. Every browser interaction has a prediction, before/after screenshots and a bug check, or an explicit interrupted-evidence record; all execution outcomes are preserved for future training. Video is disabled by default.

## Identity and storage

PostgreSQL is authoritative for relationships and lifecycle. The local S3-compatible bucket is configured as `qa-evidence`; it stores immutable PNGs, masks, observation payloads and manifests as the corresponding implementation slices become available. ClickHouse receives analytical projections. Workers use IDs through an authorized evidence API, not arbitrary filesystem paths or permanent public URLs.

| ID | Meaning |
|---|---|
| `action_id` | One planned browser interaction, allocated before dispatch and linked to run, worker, attempt, page and sequence; its lifecycle records whether dispatch occurred. |
| `prediction_id` | Expected transition and observable criteria frozen before that action; records inferred/user-specified provenance. |
| `observation_id` | Timestamped browser state, URL, geometry, DOM/network/console excerpts and capture references. |
| `capture_id` | One screenshot occurrence, with phase (`before`, `after`, `transient`), time, geometry and action. |
| `comparison_id` | Before/after pair, algorithm/version, raw and aligned mask references, geometry and change summaries. |
| `check_id` | Assessment of the action against its prediction and evidence; separate from a case verdict. |
| `export_id` | Immutable training manifest identifying sources, transformations, labels and dataset split. |

Generate globally unique IDs independently of image contents. Two identical screenshots have different capture IDs. Their encoded bytes can share a SHA256-addressed blob within the same workspace and security class; never deduplicate across raw/redacted access boundaries. Record encoded-byte SHA256, dimensions, format, byte length and bucket object version where supported. Use separate hashes for decoded pixel arrays if needed; PNG metadata differences need not imply a visual change.

`capture_id` is the canonical capture identity. The product JSON API's `captureId`, `beforeCaptureId` and `afterCaptureId` are camelCase aliases of `capture_id`, `before_capture_id` and `after_capture_id`; they preserve the same values. The seven supplied screenshots have unique archive capture IDs, `purpose: design_reference` and `training_status: excluded_reference`. They are not browser observations and have no invented action, prediction or check IDs.

Example namespaces are `workspace/<id>/blobs/sha256/<digest>.png` and `workspace/<id>/runs/<id>/manifests/<manifest_id>.json`. Redaction and masks create new artifacts referencing their inputs; they never overwrite originals. Shared blobs are deleted only when no retained capture/export references them.

## Crash-safe action chain

1. **Intent and prediction.** Persist action type/target, redacted arguments, secret references, scope, preconditions, expected transition and prediction provenance. Reserve action, model and evidence capacity for the entire chain. User context is optional; inferred expectations remain labeled.
2. **Before.** Capture the actual page immediately before dispatch, allocate a new capture ID, persist bytes to the durable spool, checksum/upload/verify them, and commit the before observation. If the scene materially differs from the prediction's input, refresh that prediction before acting. Missing before evidence prevents dispatch.
3. **Action.** Recheck lease/generation, scope and capture freshness immediately before dispatch; stop or refresh evidence if stale. Persist dispatch intent and execute once. Record start/end, success/error and safe tool output. A crash between dispatch and acknowledgement produces `outcome_unknown`; a database transaction cannot make a website mutation exactly once.
4. **After.** Capture after the operation, including errors where the page survives. Add bounded transient captures when warranted. Persist/upload the observations and comparison artifacts. If the browser dies, retain the missing-capture reason; never synthesize a replacement frame or present a later replay as this action's after image.
5. **Assessment.** Compare prediction, captures, masks and other observations. Persist `no_issue_observed`, `suspect`, `blocked` or `inconclusive`, with evidence IDs and uncertainty. A failed capture/check blocks this worker's next interaction until recovery or a terminal evidence-gap result. Another independent worker may continue.
6. **Finalize.** Commit an immutable manifest revision and accounting. Suspects enter independent reproduction later; the separate attempt uses the same capture/check contract. Reproduction cannot retroactively fill the original action's evidence gap.

Opted-in queued runs now have [bounded automatic reproduction tasks](../exploration/automatic-reproduction.md). Task IDs, source action IDs, child job/run IDs, reservations and scheduling reasons are durable PostgreSQL records with ClickHouse event export. The source manifest stays immutable; later scheduling, cancellation and human-review records appear in live reports. Automatic replay never changes the source assessment or supplies a human-confirmed training label.

Instrument navigation, clicks, typing/fill, selection, hover, scroll, keypress and explicit waits. Login/setup interactions are included. Screenshot collection and bug-check computations are observations, so they do not recursively generate actions. Preserve failed, cancelled and blocked work as well as successes; do not record hidden model reasoning.

An upload retry keeps the original capture ID and bytes. Upload immutable objects with checksums, verify length/integrity, then mark the capture available. If the worker dies after upload but before commit, reconcile the object against its durable journal. Use conditional creation where supported; verify existing content on retries. Do not treat an ETag as a universal content checksum. Amazon S3 supports upload/retrieval checksum facilities; a compatible local implementation must pass its own capability tests, with read-back verification where necessary. [S3 integrity documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)

Bound the persistent retry spool and pause admission before it fills. Keep unuploaded evidence across process restarts. A disk failure can still lose data; make gaps visible and back up both metadata and bucket objects.

## Image subtraction and tiny-change checking

Capture lossless PNGs with recorded viewport, device scale, scroll offsets, dimensions, timestamp and browser version. Use viewport frames as the canonical pair; full-page captures are supplementary and record their different geometry. Preserve device pixels, allow animations and set caret behavior to `initial`; Playwright otherwise hides the caret by default. Do not inject visual-normalization styles or resize away tiny changes in source evidence. Pin all screenshot options in the capture policy. [Playwright screenshot options](https://playwright.dev/docs/api/class-page#page-screenshot)

For comparable frames, decode to a documented channel/color representation and compute absolute per-channel differences. Preserve an unthresholded delta image and a raw binary mask marking **every nonzero pixel**. Keep tiny connected components; do not impose a minimum area that removes one-pixel changes. Record bounding boxes, maximum/total delta and the union of changed regions. Enlargement and contrast amplification produce labeled viewing derivatives, never replacement evidence.

Produce a separate aligned comparison using known viewport/scroll geometry and stable anchors. Keep transform parameters, uncertainty and original-coordinate mappings. Do not align a moved control back onto itself and erase the bug. Changed viewport/page identity or uncertain registration makes that comparison explicitly incomparable; retain raw frames and examine regions independently. Newly exposed scroll regions carry a coverage mask, not an invented before image.

Rank animation, caret and anti-aliasing noise separately; preserve their raw pixels. Feed the checker the before/after images, raw overlay, aligned view, tiny-change crops and DOM/network observations. A subtle selected state may be correct; a zero mask can hide an invisible state change or a failed interaction. Neither zero nor large delta establishes success. Assess expected behavior, including unchanged regions that should have changed.

Observe transients with a bounded policy, initially up to three extra captures within two seconds. Record requested/actual sample times and sampling gaps. Capture events, DOM changes and response timing alongside frames. This does not guarantee every animation frame or toast was observed; uncertainty remains explicit.

## Training corpus and observability

Retain the execution corpus by default; no automatic seven/thirty-day evidence expiry. Set storage quotas, backups and an explicit retention/export/deletion policy. On quota exhaustion, pause new interactions instead of discarding old evidence. Authorization can require deletion; audit it and reconcile derived exports and backup policy rather than claiming undeletable data.

Preserve model/provider/prompt/tool versions, structured inputs/outputs, action choices, observations, predictions, checks, reproduction links, errors, timings and token usage. Keep credential values and authentication state in the vault. Restricted encrypted originals and versioned redacted derivatives have separate access controls; standard model/training inputs use approved derivatives. If capture-time masking was necessary, record what was excluded.

An export manifest pins every source ID/hash, extraction/redaction policy, feature/mask version and label revision. Keep inferred predictions, model judgments, reproduced behavior and human adjudications as distinct fields. Reproducing a behavior does not prove an inferred expectation was correct. Human labels record actor, time, rationale and disagreements; corrections create new versions.

Export successes, failures, no-change actions and uncertainty without converting missing evidence into negative examples. Split evaluation data by application/revision/journey groups to avoid adjacent screenshots or repeated attempts leaking between training and evaluation. Record sampling and class-balancing decisions. Exporting data does not automatically authorize sending it to an external training provider.

ClickHouse supports investigations by workspace/user/provider connection and run/worker/action/check: tokens reported by the provider, image usage when available, latency, retries, browser seconds, image-processing time and stored bytes. Missing fields remain unknown. PostgreSQL settles usage idempotently; ClickHouse projections deduplicate on immutable event/request IDs. Neither analytics availability nor inferred token estimates may decide a verdict or override a budget. An estimated reservation is not a guaranteed dollar limit when the provider route cannot enforce a request/output maximum.
