---
{
  "title": "Evidence, storage and training data",
  "description": "Understand screenshot UUIDs, lossless image differences, private object storage, model-call records and the boundaries of future training use.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 4
  }
}
---
Scout records automated browser work so observations can be inspected and referenced later. Screenshots are lossless PNGs in a private S3-compatible bucket. Every capture and artifact has a unique ID, hash and byte length.

## What is retained

- Before/after captures linked to run and action UUIDs.
- Exact typed actions, frozen expectations, assessments and state-graph decisions.
- Completion samples and their capture references.
- Exact image-difference metadata and masks.
- Bounded browser/network diagnostics with sensitive details omitted.
- Model request/response records, attempts and nullable usage.
- Independent reproduction lineage and append-only human review history.

The current recorder does not save a continuous video. Screenshots and sampled frames support action-level inspection without a full video stream. Storage size still grows with runs, images and model payloads.

## How image subtraction is used

The image-difference service compares exact RGBA pixels and records changed-pixel counts, geometry and a mask. It does not discard tiny differences. The mask helps locate changes; it does not establish what should have happened.

A screenshot can be unchanged after a broken save. A correct menu animation can change many pixels. The behavioral assessment uses the prediction and prior context alongside the image evidence.

## Private sign-in is excluded

Human sign-in frames, passwords, verification codes, cookies and saved-session material do not enter ordinary evidence or model prompts. The private login browser is a separate recording boundary.

After sign-in, normal app screenshots can contain personal data displayed by the app. Use dedicated test accounts and synthetic data. [Private app access](../../getting-started/private-apps/) explains session handling.

## Training is a separate decision

Evidence retention is not consent or approval to train a model. The product does not yet provide an approved dataset export or a training pipeline. Human review labels, record provenance and verified evidence are useful inputs for future curation; they do not replace consent, filtering or dataset governance.

Keep the bucket and database private. Publishing these documentation files does not publish run evidence.

## Read and back up evidence

Use [capture and artifact endpoints](../../api/evidence/) or the workspace’s [portable exports](../../guides/reports/). Docker volumes preserve data across container recreation but are not an off-machine backup. See [storage and observability](../../operators/data/).
