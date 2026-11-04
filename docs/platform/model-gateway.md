# Model gateway

Every model call goes through the Rust API's gateway (`apps/api/src/gateway.rs`, `models.rs`): explorer planning, predictions and action assessments, reproductions, and direct requests. It supports OpenAI, Anthropic (Claude), OpenRouter and Meta with API keys, records every request and attempt in PostgreSQL, uploads payloads to the evidence bucket and exports events to ClickHouse.

## Credentials

- **Hosted users** add named personal keys in **Settings → Models**, or use the sponsored Meta demo connection. See [provider access](./provider-access.md) for key storage, selection and demo credit.
- **Operator and local development:** set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` or `META_API_KEY` in `.env` (`MODEL_API_KEY`, the name in Meta's examples, is used when `META_API_KEY` is empty). Only the API container receives them. They are not a fallback for hosted user accounts.

Humans use their app session and agents use scoped bearer credentials. Raw `POST /v1/model-requests` is for the operator token and the browser worker; the gateway derives the account and key from the admitted run.

## Direct requests

Create a request file with a new UUID:

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

Resubmitting the same UUID with the same normalized input returns the existing request without another call; different input under that UUID returns HTTP 409. For vision, add `run_id`, optionally `action_id`, and up to two `capture_ids` from that run. Each PNG must be in the bucket and at most 4 MiB; ownership, size and SHA-256 are checked before the bytes are sent. Image URLs and provider endpoint overrides are not accepted.

| Route | Behavior |
| --- | --- |
| `GET /v1/model-providers` | Configured providers, gateway readiness, fixture/live mode, safe key metadata and demo balance; no secrets |
| `POST /v1/model-requests` | HTTP 202 after admission commits; 200 for an identical existing request |
| `GET /v1/model-requests/{request_id}` | Request, attempts, output, usage, payload references and export state |
| `GET /v1/usage` | Per-user usage for the current execution mode |
| `GET /v1/runs/{run_id}` | Includes the model usage linked to the run |

## Providers

All calls are non-streaming text-plus-image requests. Provider output is a proposal; the gateway does not run tools, and a response is not evidence that a browser action succeeded.

| Provider | Endpoint and request |
| --- | --- |
| OpenAI | Responses API, `store: false` |
| Meta | `POST https://api.meta.ai/v1/responses` with a bearer token: Responses `input` with `input_image` data URLs, `instructions`, `store: false`, `reasoning.effort: low` (reasoning tokens share `max_output_tokens` with the answer). Computer-use requests add the `computer` tool. Usual models: `muse-spark-1.3`, `muse-wonder-1.0` |
| Anthropic | Messages API, `anthropic-version: 2023-06-01` |
| OpenRouter | Chat Completions with `provider.require_parameters: true` and `data_collection: deny` |

**OpenRouter free-only** (`free_only: true`, the default for `SCOUT_EXPLORER_FREE_ONLY`) sets zero price ceilings for prompt, completion, request and image, so only free routes such as `openrouter/free` or `:free` models can serve the call. No fallback model list or paid plugins are sent. The filters can leave no available endpoint and do not guarantee vision support; `openrouter/free` may pick a different model between calls. `free_only: false` permits the selected paid route. The requested and returned model, routed provider and generation ID are recorded.

Meta does not report a dollar cost, so the gateway stores none for personal Meta keys; the workspace estimates cost from the prices in its model catalog (`packages/web-ui/src/catalog.js`) or the user's own prices.

## Evidence and recovery

```text
POST → PostgreSQL request + event → HTTP 202
  → dispatcher resolves screenshot IDs
  → PostgreSQL call ID + request bytes + dispatch event
  → provider HTTP call
  → fsync response journal on the gateway-spool volume
  → PostgreSQL response + usage + completion event
  → immutable S3 upload + SHA-256 readback
  → ClickHouse projection + outbox acknowledgement
```

Each HTTP attempt gets a new `call_id`; `request_id` groups retries. Payloads are stored at `workspace/<workspace_id>/model-calls/<call_id>/<request|response>-<sha256>.json`. Malformed or partial response bytes are kept as received, so a `.json` object may not parse. PostgreSQL also keeps the payload bytes after upload; nothing expires them. ClickHouse holds searchable prompt, system and output text, errors, usage and payload references; large image bodies stay in S3. Query `scout.model_events_current` and `scout.model_usage` to count without delivery duplicates.

Authorization headers are never serialized. Known credentials are rejected in prompts and scrubbed from responses, including JSON-escaped echoes. This is credential filtering, not a general secret or personal-data detector.

One API process holds a PostgreSQL advisory lock and dispatches one provider call at a time; other replicas stay ready and admit work. Each workspace can have up to 32 open (queued or in-flight) requests per execution mode. Requests survive client disconnects. After a restart, a synced journal replays idempotently. If dispatch committed but no complete journal exists, the attempt becomes `unknown` and is not sent again. A journal or settlement failure halts new spending until the API is restarted after storage is restored.

Only complete HTTP 429 responses are retried automatically, as a new attempt after `Retry-After` (five seconds if absent); requests allow one to three attempts. Timeouts, disconnects, malformed responses, 402/403, redirects and 5xx are not retried. Calls time out after 60 seconds, accept 1–4096 output tokens, and capture at most 2 MiB of response (overflow keeps the prefix and reports `response_size_limit`).

New requests for a cancelled run are rejected, and queued ones are checked again before dispatch. Calls already sent settle normally. See [run cancellation](../exploration/cancellation.md).

## Usage

Missing or invalid provider usage stays `unknown` or `partial`, also on successful responses. Cached and reasoning subtotals are kept separately and not added twice. OpenRouter's reported cost is stored as a PostgreSQL decimal; direct-provider prices are never guessed, and absent costs stay null.

The normal service reports `live` usage. The test gateway (`just model-test`) runs in `protocol_fixture` mode against a local fake provider on `127.0.0.1:18081`, ignores real keys, and never adds to live totals.

## Not built yet

- Subscription sign-in (ChatGPT plans, Claude accounts) instead of API keys.
- Streaming responses.
- Monetary reservations, billing reconciliation and organization quotas for personal keys (only the Meta demo connection reserves credit).
