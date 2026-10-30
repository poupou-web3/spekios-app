# Reviewing a finding

The Findings tab distinguishes **Needs review**, **Human confirmed**, and **Dismissed**. Open a suspected action, inspect its screenshots and reproduction, then record a decision in **Human review**. A reason is required for every decision. Confirmation also requires a severity and an explanation of the product requirement or user expectation that makes the behavior a defect.

The current decision is the latest review revision. Dismissed findings remain available through the Dismissed or All candidates filters and the original action timeline. Choose **Needs further review** to reopen a decision. Every correction appends a new revision; prior decisions remain visible with their reviewer, timestamp, reasoning and evidence snapshot. Draft input survives automatic workspace refreshes.

## Confirmation requirements

The API verifies that the source is a completed suspect action from a terminal, original explorer run, with a supported frozen expectation, complete observations and available evidence. Tool errors, uncertain expectations and unresolved action completion cannot support confirmation. Deterministic recorder checks and replay actions cannot be reviewed as new source findings.

Confirmation additionally requires the existing independent reproduction to have completed with `reproduced` and a matching final state. The service checks the saved path, source/replay action and capture IDs, frozen expectations, geometry and state fingerprints. Those fingerprints identify the route, controls and visible text. It reads back screenshots and comparison/completion/diagnostic artifacts from private storage and verifies each object's byte length and SHA-256. A missing or invalid object prevents confirmation.

A reviewer may dismiss or reopen a complete candidate before reproduction succeeds. A human decision requires no new model call and remains available when no model provider is configured. The current local bearer token identifies one developer; separate reviewer accounts and hosted reviewer permissions remain future work.

## Evidence and training labels

`finding_reviews` is an append-only PostgreSQL table. Each row has a globally unique `review_id`, source `action_id` and `run_id`, owner/reviewer IDs, monotonic revision, disposition, rationale, expectation basis, severity, timestamp and `evidence_snapshot`. The snapshot pins original predictions and assessments, capture/artifact identities and hashes, reproduction lineage and evidence verified when the review was saved.

Model assessments and reproduction results are preserved. Their original `confirmed_bug: false` describes what the automated evaluation established; the human decision is a separate field. Historical run manifests remain unchanged. Current run reports and exported report JSON include `finding_reviews`, including reviews linked to the source of a replay. Future dataset exports can pin a specific review UUID and revision.

Review snapshots and events retain the source training classification. Bundled fixtures remain `excluded_fixture`. Confirmation does not change `training_status`, approve privacy/redaction, or automatically authorize model training. Dataset export, retention controls and a training approval workflow remain separate work.

## API

Authenticated `POST /v1/actions/:action_id/reviews` accepts:

```json
{
  "review_id": "NEW_UUID",
  "expected_revision": 0,
  "disposition": "confirmed",
  "rationale": "The independent replay shows the same failure.",
  "expectation_basis": "The visible Save control promises to save the displayed draft.",
  "severity": "medium"
}
```

Use a real UUID. Disposition is `confirmed`, `dismissed` or `needs_review`. Rationale must contain 1–2,000 characters; expectation basis is at most 2,000 characters and requires at least ten for confirmation. Severity is `low`, `medium`, `high`, `critical`, or null; confirmation requires a severity. Unknown fields and invalid values are rejected. The server sets owner and reviewer identities.

A new review returns 201 with `{review, reused: false}`. Retrying identical content with the same UUID returns 200 and its original row, including after later reviews. Changing that UUID's content returns 409 `review_id_conflict`. `expected_revision` must equal the latest saved revision; a concurrent or stale decision returns 409 `revision_conflict`. The GUI refreshes history while preserving draft text and requires an explicit retry.

Missing or foreign actions return 404. Ineligible sources, missing reproduction and incomplete evidence return 409. Evidence storage and integrity failures return a gateway error, with no new review saved. Requests are scoped to the local workspace and owner.

## Observability and recovery

Each saved decision atomically appends a `finding.reviewed` event to the source run. The event carries the review identity, revision, actor and training classification. The browser worker exports bounded batches while idle, independently of model readiness. ClickHouse downtime leaves the review and outbox durable in PostgreSQL. Retried delivery reuses event IDs; analytical queries use the deduplicated current view.

## Verification

`just reviews-test` runs simulated-model browser exploration and fresh reproduction, then exercises human review against real PostgreSQL, object storage and ClickHouse. It checks strict authorization, confirmation gating, concurrent revisions, UUID reuse, missing/tampered evidence, append-only history, unchanged original evidence, fixture exclusions, source/replay lineage and outbox recovery across a ClickHouse outage. It restores ordinary model configuration and verifies that reviewing existing evidence adds no inference calls. Results are saved in `artifacts/finding-reviews/verification.json`.

Frontend tests cover separate statuses and filters, confirmation gating, escaped text, preserved drafts, duplicate submission and concurrency conflicts. Visual browser inspection and live-model QA accuracy remain unverified.
