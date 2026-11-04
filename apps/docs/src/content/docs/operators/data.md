---
{
  "title": "Storage, observability and backups",
  "description": "Operate Spekios’s private evidence bucket, PostgreSQL authority, ClickHouse observability, durable outboxes and separate encrypted authentication vault.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 2
  }
}
---
PostgreSQL stores authoritative metadata and delivery state. Private S3-compatible storage holds large evidence objects. ClickHouse receives analytical events through durable outboxes.

## Recorded observability

Model requests and attempts retain request/response payload references, provider/model identity, run/action links, execution mode and nullable usage. Failed attempts and late results remain recorded.

Runtime and human-review events have durable IDs and sequence/revision context. The back office shows pending delivery counts. Use those counts to investigate export lag; they are not a direct probe of every service.

A log collector ships every container's output to ClickHouse for the back office **Logs** view.

Authenticated route/tool metadata and OAuth token issuance have an identity audit outbox. Full MCP transport input/output payload auditing is not implemented. Authorization codes and access/refresh tokens are excluded from analytical events.

## Evidence objects

The private bucket is **qa-evidence**. Captures and artifacts carry UUIDs, hashes and lengths. Retrieval verifies recorded bytes. Avoid manually rewriting objects or metadata to make a broken hash appear valid.

Lossless PNGs and sampled frames are retained instead of continuous video. Disk consumption depends on action count, viewport dimensions, PNG content and model payload volume. Measure your own runs; there is no fixed per-run storage claim.

## Persistent local state

The Compose stack uses named volumes for PostgreSQL, ClickHouse, evidence, gateway/recorder spools and the authentication vault. Recreating containers preserves these volumes.

The auth vault is separate from ordinary evidence. It contains encrypted saved-session material and a local key. An administrator who has both can decrypt it.

Personal model-provider keys (and PostHog connection keys) are stored encrypted in PostgreSQL with **SCOUT_PROVIDER_VAULT_KEY** from **.env**. Keep that key with your backups; replacing or losing it makes saved keys unreadable.

## Back up before migration

Preserve database metadata, evidence objects and required spool state together so IDs and hashes remain meaningful. Back up the vault separately when you need session reuse, with access appropriate to credentials.

An off-machine backup and a tested restore are operator work; no automated off-site backup/retention service is configured by the stack. Do not remove local volumes until a restore has been verified.

Training approval, retention policy automation and curated dataset export remain future work.
