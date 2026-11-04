---
{
  "title": "Retrieve verified evidence",
  "description": "Fetch Spekios capture metadata, screenshot PNGs and artifacts with run-scoped MCP retrieval and server-side SHA-256 verification.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 5
  }
}
---
Reports reference evidence by UUID. Retrieve those objects from the authenticated API rather than reaching directly into the private bucket.

## REST downloads

~~~text
GET /v1/captures/{capture_id}
GET /v1/captures/{capture_id}/image
GET /v1/artifacts/{artifact_id}/content
~~~

The metadata endpoint describes the recorded capture. The image route returns PNG bytes. The artifact route returns its recorded content type.

The server checks scope and verifies recorded hash and byte length. Missing, unavailable or mismatched evidence produces an explicit failure rather than a substitute image.

## MCP and HTTP tool retrieval

Call **scout_read_evidence** with **run_id** and exactly one of **capture_id** or **artifact_id**.

PNG evidence returns an MCP image block and metadata. JSON artifacts return parsed data with metadata. Ownership and membership in the selected run are checked independently of shared blob content.

Returned PNGs are limited to four MiB. JSON artifacts and their metadata are limited to 128 KiB. Use the ordinary authenticated downloads for larger evidence.

## Reference the original IDs

Include run, action, capture and artifact IDs when sharing a report with another agent. They make the chain from claim to action to bytes reviewable.

An image hash is an integrity check, not proof that an inferred expectation is correct. A fresh reproduction has its own run and evidence IDs.

## Excluded material

Private human-login frames and saved-session contents are not ordinary evidence and cannot be retrieved with these tools. They are outside the model/training recording boundary.

Normal post-login screenshots can still show sensitive app data. Prefer test accounts and limit who can access exports.
