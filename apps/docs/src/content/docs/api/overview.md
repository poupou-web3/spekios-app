---
{
  "title": "HTTP API overview",
  "description": "Integrate Spekios’s authenticated REST API, durable browser jobs, progress, reports, evidence and shared agent tools.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 1
  }
}
---
The Spekios API is a Rust/Axum service. The local Compose stack exposes it at **http://127.0.0.1:18080**. The documentation is a separate static service and never proxies credentials or API requests.

## Choose an interface

| Interface | Use |
| --- | --- |
| REST | Ordinary job admission, progress, reports, evidence, settings and model requests. |
| HTTP tools | The MCP tool catalog and dispatcher over JSON HTTP. |
| MCP | Streamable HTTP or the local Rust stdio bridge for agent clients. |

The core async workflow is the same: submit once with a stable UUID, poll when convenient, retrieve the report, inspect evidence and run a fresh job after a fix.

## Machine contract

Download [OpenAPI 3.1](../../openapi.json) for the documented integration surface. The reference explicitly models request bounds and admission/report responses. Some raw recorded projections are extensible objects, not complete generated client types.

Human private-login control and human review are described in the guides rather than exposed as agent actions. Their GUI protocols are outside this OpenAPI document’s scope.

## Conventions

- JSON request and response bodies unless downloading binary evidence.
- UUID identifiers; command IDs must be non-nil.
- Protected requests require a Bearer token.
- Body size limit: 64 KiB for the protected API.
- Read endpoints do not start a model inference.
- Unknown fields are rejected by strict typed submissions; malformed requests return errors.
- IDs are checked against the local workspace/user and relevant run bindings.

## Suggested path

1. [Configure authentication](../authentication/).
2. [Submit a browser job](../jobs/).
3. [Read progress and reports](../progress-reports/).
4. [Fetch evidence](../evidence/).
5. [Handle errors and retries](../errors/).

The current backend is a local single-developer system. Public deployment needs additional authentication and isolation work; public static docs can be deployed independently.
