---
{
  "title": "Call agent tools over HTTP",
  "description": "Discover Spekios’s shared MCP schemas and invoke tools over authenticated JSON HTTP with consistent result envelopes and domain errors.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 6
  }
}
---
The HTTP tool adapter exposes the same shared tools as MCP. It is useful when a client can make HTTP requests but does not implement MCP transport.

Use a native agent credential from browser pairing (for example, the one **scout-mcp login** saves) as the Bearer token. MCP OAuth tokens are bound to **/mcp** and are rejected here. The examples read the token from **SPEKIOS_TOKEN** and the API origin, such as **https://app.spekios.com** or **http://127.0.0.1:18080**, from **SPEKIOS_SERVER**.

## Discover the catalog

~~~sh
curl --fail-with-body \
  --header "Authorization: Bearer $SPEKIOS_TOKEN" \
  "$SPEKIOS_SERVER/v1/agent/tools"
~~~

The response includes instructions, tool names, schemas and annotations. The docs’ [catalog snapshot](../../mcp-tools.json) comes from the same Rust definition.

## Call a tool

Send the argument object directly, without a JSON-RPC wrapper:

~~~sh
curl --fail-with-body \
  --header "Authorization: Bearer $SPEKIOS_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"job_id":"00000000-0000-4000-8000-000000000001"}' \
  "$SPEKIOS_SERVER/v1/agent/tools/scout_get_job"
~~~

## Read the result

Responses use the MCP tool-result envelope:

- **content:** text and, for image retrieval, image blocks.
- **structuredContent:** the structured projection.
- **isError:** whether the tool result represents a domain failure.

Successful calls return HTTP 200, including job admission. Inspect the job’s status instead of expecting a completed run. Ordinary REST admission uses 202 for a newly queued job.

Domain failures preserve their HTTP status and structured **error**, **http_status** and **retryable** fields. Schema errors use 400; unknown tool routes use 404.

Through MCP, invalid arguments/protocol errors are JSON-RPC errors, while domain failures are tool results with **isError=true**.

## Scope and limits

Request bodies are limited to 64 KiB; structured replies to 128 KiB. Strict input schemas reject unknown fields and runtime validation enforces cross-field selector rules.

Reads do not call a model. Starting exploration or reproduction can change data on the target site and consume configured model usage. Human review and private-login control are intentionally absent from the agent tool set.
