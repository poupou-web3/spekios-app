# Rust model gateway

Implemented on 22 October 2026: asynchronous OpenAI, Claude and OpenRouter calls; screenshot-ID inputs; durable request/attempt records; per-user usage; S3 payloads and ClickHouse telemetry. The [bounded URL explorer](../exploration/overview.md) now uses this gateway for planning, predictions and every action assessment.

## Connect and use a provider

Add `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `META_API_KEY` to the private, ignored `.env`, then run `just dev` and `just models`. Meta’s docs call that bearer token `MODEL_API_KEY`; if `META_API_KEY` is empty, the gateway uses `MODEL_API_KEY`. Keys are passed only to the Rust API. This increment supports API-key authentication; ChatGPT subscription token sharing and native Claude Code authentication remain future adapters. Capabilities explicitly report `subscription_auth: false`. See [authentication boundaries](./models.md).

Create `artifacts/request.json` with a new UUID:

```json
{
  "request_id": "912f7e24-29c7-405f-a5e4-8fe345793ea3",
  "provider": "openrouter",
  "model": "openrouter/free",
  "prompt": "Describe the expected result of clicking Save on a settings page.",
  "max_output_tokens": 512,
  "max_attempts": 2,
  "free_only": true
}
```

```sh
just model-call artifacts/request.json
just model-request 912f7e24-29c7-405f-a5e4-8fe345793ea3
just usage
```

Resubmitting the same UUID and normalized input returns the existing request without another call. Changed input under that UUID returns HTTP 409, including changes between fixture/live execution modes. For vision, add `run_id`, optionally `action_id`, and up to two `capture_ids` from that run. Each PNG must be available in the bucket and at most 4 MiB. Ownership, size and SHA256 are checked before sending image bytes. Arbitrary image URLs and provider endpoint overrides are not accepted.

| Route | Behavior |
| --- | --- |
| `GET /v1/model-providers` | Configured providers, authentication, gateway readiness, fixture/live mode; no keys |
| `POST /v1/model-requests` | HTTP 202 after committing admission; 200 for an identical existing request |
| `GET /v1/model-requests/{request_id}` | Request, attempts, output/usage, payload references and export state |
| `GET /v1/usage` | Authoritative per-user usage for the current execution mode |
| `GET /v1/runs/{run_id}` | Includes model usage linked to the run |

All data routes require the local `SCOUT_API_TOKEN`. This represents one local developer workspace/user, not multi-user authentication.

Provider mappings use [OpenAI Responses](https://developers.openai.com/api/docs/guides/text), [Meta Model API Responses](https://dev.meta.ai/docs/protocols/responses), [Claude Messages](https://platform.claude.com/docs/en/api/messages/create), and [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion). Calls are non-streaming text-plus-image requests. OpenAI and Meta use `store: false` so prompts and screenshots are not retained by the provider; Claude pins API version `2023-06-01`. Meta posts to `https://api.meta.ai/v1/responses` with bearer authentication. The usual model ID is `muse-wonder-1.0`. Meta usage follows the Responses token fields, and a missing price stays null. The gateway does not execute model-generated tools. Provider output is a proposal, not evidence that a browser action succeeded.

OpenRouter defaults to free-only: model `openrouter/free` or an explicit `:free` model, with zero price ceilings for prompt, completion, request and image. No fallback model list or paid plugins are accepted. Routing requires parameter support and denies data-collecting providers. These filters can result in no available endpoint; they do not guarantee vision support. `free_only: false` explicitly permits the selected paid route. Requested/returned model, routed provider and response/generation ID are recorded. [Routing controls](https://openrouter.ai/docs/guides/routing/provider-selection)

## Evidence and recovery

```text
POST → PostgreSQL request + event → HTTP 202
  → background worker resolves screenshot IDs
  → PostgreSQL call ID + request bytes + dispatch event
  → provider HTTP call
  → fsync response journal on gateway volume
  → PostgreSQL response + usage + completion event
  → immutable S3 upload + SHA256 readback
  → ClickHouse projection + outbox acknowledgement
```

Each actual HTTP attempt gets a new `call_id`; `request_id` groups retries. Run/action/capture/user/workspace IDs preserve provenance. Payload IDs reference S3 objects at `workspace/<workspace_id>/model-calls/<call_id>/<request|response>-<sha256>.json`. Malformed/partial response bytes are retained, so a response file with a `.json` suffix may not parse as JSON.

PostgreSQL retains payload bytes as an upload outbox even after S3 verification. This duplicates storage during development; no automatic expiry or training export is enabled. ClickHouse events contain searchable prompt/system/output text, errors, usage and payload references. Large image/base64 bodies stay in S3. Query `scout.model_events_current` and `scout.model_usage` to deduplicate deliveries before counting them.

Authorization headers are never serialized. Known configured credentials are rejected in prompts and scrubbed from responses, including JSON-escaped echoes. Other response bytes remain unchanged unless invalid UTF-8 or NUL needs normalization. This is credential filtering, not a general detector of personal data or secrets in screenshots. Live requests are `pending_review` for training; protocol fixtures are `excluded_fixture` with a separate execution mode.

One worker holds a PostgreSQL advisory lock on a dedicated connection; up to 32 requests may wait, with one provider call in flight. Requests survive client disconnect. A synced journal replays idempotently after restart. If dispatch committed but no complete response journal exists after a crash, the attempt becomes `unknown` and is not sent again. Unknown latency/usage remains null. Preparation can resume because dispatch had not committed. Journal/settlement failures halt new spending; restart after restoring storage.

Only complete HTTP 429 responses retry automatically, using distinct attempt IDs and `Retry-After` (five seconds if absent). Invalid headers or delays over a week stop automatic retry. Requests allow one to three attempts. Timeouts, disconnects, malformed responses, 402/403, redirects and 5xx responses are not automatically retried. Hidden HTTP retries and redirects are disabled.

Calls have a 60-second timeout and a 1–4096 output-token limit. Response capture is capped at 2 MiB: overflow retains the prefix, reports `response_size_limit` and `response_complete: false`, and keeps usage unknown. Test mode uses a two-second timeout. These are operational bounds, not a hard dollar budget.

## Usage

Missing or invalid provider usage stays `unknown` or `partial`, including on successful responses. Every attempt contributes to the incomplete-usage count when appropriate. Cache and reasoning subtotals are retained separately: OpenAI/OpenRouter subtotals are not added twice; Claude's separate cache-read/cache-write input counts are included in total input.

OpenRouter's reported cost is stored as PostgreSQL decimal, preserving its JSON decimal representation. Direct-provider prices are not guessed; absent costs are null. Token and cost completeness are separate. Billing reconciliation, monetary reservations, pricing snapshots and organization quotas remain unfinished. Subscription allowance cannot be inferred from raw token totals. [Usage fields](https://openrouter.ai/docs/cookbook/administration/usage-accounting)

The normal service's `just usage` reports `live` usage. The explicit test gateway reports `protocol_fixture`. Simulation totals never inflate the live account totals. Individual requests and ClickHouse retain both modes for inspection.

## Verification and next work

`just model-test` builds fake providers, enables explicit fixture mode, exercises real HTTP/PostgreSQL/S3/ClickHouse paths, and restores normal mode afterward. It briefly restarts the API and storage services while retaining all volumes. Real provider credentials are ignored in this mode; no paid inference happens.

The protocol suite passed 19 requests, 20 attempts and 59 durable events: the original three provider protocols, screenshot retrieval, concurrent idempotency, rate limits, missing/partial usage, invalid JSON, timeouts, response limits, redaction, a real process kill, S3/ClickHouse outages and replay deduplication. Reports are written to `artifacts/model-gateway/verification.json`. The separate journal verifier forces one real fixture response's settlement to fail, then tests restart recovery and replay after an already-committed settlement. Rust unit tests cover validation/usage; Clippy checks all targets with warnings treated as errors. Live-provider inference is not claimed by these fixture tests. The verifier now also exercises Meta's Responses protocol.

The explorer integration now verifies model predictions/assessments against real browser evidence using simulated provider responses. The exporter drains bounded batches without an idle delay while pending work remains. Live-model QA quality, a scoped and isolated worker protocol, structured provider tools, streaming, credential handoff, subscription authentication and monetary quotas remain to build. Fresh-browser reproduction and the [workspace/operations console](./workspace.md) now use the gateway and display its recorded requests, responses and usage.

## Cancelled runs

New requests for a cancelled run are rejected; queued requests are checked again before a provider attempt. Already dispatched calls settle normally and retain response evidence and usage. See [run cancellation](../exploration/cancellation.md).
