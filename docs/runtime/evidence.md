# Evidence

Every browser action leaves a linked, immutable evidence trail: a prediction frozen before dispatch, before and after screenshots, difference masks, settling frames and an assessment. Failed, blocked and interrupted actions are kept as well as successful ones. This page describes how that evidence is identified, stored and labelled. Downloading it is covered in [portable reports](./reports.md).

## Where it lives

| Store | Contents |
| --- | --- |
| PostgreSQL | Authoritative runs, actions, captures, artifacts, events and their relationships (`runtime_runs`, `runtime_actions`, `runtime_captures`, `runtime_artifacts`, `runtime_events`, plus the exploration and review tables) |
| Bucket `qa-evidence` | PNGs, masks and JSON artifacts, addressed by content hash |
| ClickHouse | Event projections for search and analytics, delivered from the PostgreSQL outbox |

Object keys:

```text
workspace/<workspace_id>/blobs/sha256/<sha256>.png|json      screenshots, masks, JSON artifacts
workspace/<workspace_id>/captures/<capture_id>.json           capture metadata
workspace/<workspace_id>/model-calls/<call_id>/...            model request and response payloads
```

The browser and API never use bucket URLs: screenshots and artifacts are served by `GET /v1/captures/{id}/image` and `GET /v1/artifacts/{id}/content`, which check the workspace, load the key server-side and verify length and SHA-256.

## Identity

- `capture_id` identifies one screenshot occurrence (`before` or `after` for an action). Two identical screenshots get different capture IDs; their bytes can share one SHA-256-addressed blob. A checksum is never a capture ID. The JSON API's `captureId`, `beforeCaptureId` and `afterCaptureId` are the same values.
- `action_id` identifies one planned interaction, allocated before dispatch, with its typed arguments and prediction.
- `artifact_id` identifies a derived file. Kinds include `raw_mask`, `absolute_delta`, `geometry_mask` and `comparison` (from [image-diff](../../packages/image-diff/README.md)), `settling_frame`, `action_completion`, `action_diagnostics`, `assessment_image` and `run_manifest`.
- Events carry stable IDs and per-run sequence numbers, so ClickHouse views such as `scout.runtime_events_current` and `scout.evidence_events_current` deduplicate repeated deliveries.

## Capture

Screenshots are lossless viewport PNGs at device scale. Capture hides the caret, disables CSS animations for the frame and pauses the page clock, and the context requests reduced motion. The recorded observation includes viewport, URL, geometry and timing. Full-page captures and video are not used.

The difference mask marks every changed pixel, with no minimum area, so one-pixel changes are kept. A zero difference is not a pass and a large difference is not a success; the assessment compares the prediction with the screenshots, masks and page observations. Enlarged or cropped views are separate artifacts and never replace the original.

## Durability

1. Bytes are written to the worker's durable spool (`recorder-spool` volume) before upload.
2. Uploads use conditional creation (`If-None-Match: *`) with a SHA-256 metadata field; an existing object with different contents is rejected.
3. The row becomes `available` only after the upload succeeds. A pending or failed capture stays visible as `pending_upload` or `failed`. `just recover RUN_UUID` re-uploads a run's unfinished captures and artifacts from the spool, and `just flush` exports pending events to ClickHouse.
4. A missing before or after capture is recorded as a gap; a frame is never synthesized and a later replay never fills an earlier action's gap.

Evidence never expires automatically. Back up the volumes and `.env` together ([local stack](../platform/infrastructure.md)).

## Training labels

Evidence is retained for future training but nothing is exported for it yet.

- Live captures are `unreviewed`; fixture and test-mode captures are `excluded_fixture`; the seven design-reference screenshots are `excluded_reference`. Live model requests are `pending_review`.
- AI assessments, independent reproduction results and human reviews are stored separately ([finding reviews](../exploration/finding-reviews.md)). A human confirmation does not approve data for training.
- Portable reports always set `training_approval: false`.

## Not built yet

- A versioned training-dataset export with pinned source IDs and hashes, redaction policy, label revisions and evaluation splits grouped by application.
- Redacted derivatives of captures with separate access control, and capture-time masking of sensitive regions.
- Aligned comparisons that compensate for scrolling or layout shifts before diffing.
- An explicit retention and deletion policy covering evidence, derivatives and backups.
