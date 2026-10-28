# Portable run reports

Open a recorded run and choose **Export report**. The drawer pins the currently loaded run snapshot, allocates an export UUID and records its generation time. Polling and later human reviews do not change that open export. Close and reopen it to use the latest loaded report. Active runs are explicitly identified as partial snapshots.

## Download formats

| Format | Contents |
| --- | --- |
| Markdown | Readable execution summary, ordered actions, frozen expectations, observed results, human review history, reproduction lineage, coverage limits, usage and evidence IDs |
| Evidence ZIP | Markdown and the existing run JSON, selected-run screenshots and recorded PNG/JSON artifacts, plus a SHA-256 manifest |
| JSON | The full existing authenticated run-report projection, without changing its schema or adding separate provider payloads |

Standalone Markdown contains no embedded or external image links. In a ZIP, Markdown references only verified images through fixed relative paths. Extract the archive before opening the Markdown in a viewer that supports local images. Text from the tested application, models and reviewers is escaped; long prose is explicitly truncated in the readable report while the raw JSON retains the source projection.

The readable report keeps AI suspicion, independent reproduction and human review separate. A confirmed source finding does not become a newly confirmed replay finding. Missing token or cost values remain unknown; partial usage is labeled as a known subtotal. Action-budget use is not application coverage.

## Evidence and integrity

The archive contains:

```text
report.md
report.json
manifest.json
captures/<capture_uuid>.png
artifacts/<artifact_uuid>.png
artifacts/<artifact_uuid>.json
```

Only capture and artifact rows belonging to the selected run are eligible for download. Action/phase references and nested artifact descriptors are checked against those rows. Malformed IDs, conflicting duplicate metadata, missing rows and references to another run become explicit gaps. Paths are generated from validated UUIDs; application URLs, bucket keys and control names are never used as archive paths or download addresses.

Files are read through the existing private capture/artifact API. Each download is bounded and checked for media type, exact byte length and SHA-256. PNG signatures and JSON decoding are checked too. ZIP STORE preserves the original PNG bytes without recompression. Identical settling images may share one artifact; their distinct frame occurrence IDs and action links remain in the report and manifest.

The manifest pins the export UUID, source run, lifecycle, generation time, limits, file hashes and evidence outcomes. Its `files` list hashes `report.json`, `report.md` and included evidence; it does not recursively hash itself. Evidence entries retain their recorded status and one of these export outcomes:

| Outcome | Meaning |
| --- | --- |
| `included` | Downloaded bytes passed verification and are present at the listed path |
| `unavailable` | Evidence was pending, failed or missing in the pinned snapshot; no download was attempted |
| `invalid_metadata` | Identity, ownership, references or recorded metadata did not meet the export contract |
| `not_included` | A valid listed file exceeded the per-file limit |
| `failed_verification` | Retrieval, format, length or checksum verification failed; bytes were excluded |

The archive-level `evidence_status` is `all_listed_files_verified`, `contains_gaps` or `no_evidence_listed`. Successful ZIP generation can still contain gaps. Inspect the manifest rather than treating a download as complete evidence. Integrity checks establish that included bytes match recorded descriptors; they do not establish that the application's behavior is correct or independently prove capture provenance.

Related source/replay runs remain references by ID. Their evidence must be exported from those runs separately; `related_run_evidence_included` is false. An active snapshot can omit future actions or uploads even when all files listed at export time verified successfully.

## Bounds and cancellation

The evidence ZIP limits are 256 evidence inventory entries, 8 MiB per evidence file, 8 MiB for each generated document inside the bundle, 64 MiB for the ZIP and two minutes for evidence export. Declared aggregate size is checked before downloading, with space reserved for metadata and the ZIP directory. The final archive is checked again. Exceeding the inventory, document, aggregate or archive limits stops bundle export with a visible error; an oversized individual file can instead remain a manifest gap when the aggregate admission check passes. Standalone Markdown and JSON do not fetch evidence or use the ZIP's evidence limits.

The drawer shows processed files, verified files, gaps and downloaded bytes. **Cancel download**, closing the drawer, navigating away or disconnecting aborts pending export work and prevents a late download. Cancelling an export does not cancel the browser run or change its evidence. Recorded JSON remains available when an evidence ZIP is too large; this increment does not add a streaming server export service.

## Scope and storage

The full JSON projection can include tested application URLs, observed page content, action arguments, diagnostics and review rationale. It retains the same scope as the previous JSON download. Separate raw model request/response payloads, provider credentials, workspace tokens and private saved login sessions are not fetched or added. Review application data before sharing an archive.

Exports stay on the local machine: browser downloads or CLI output files. They make no model calls, create no PostgreSQL tables or rows, write no export objects to S3 and upload nothing off the machine. The browser uses existing authenticated read endpoints. The only API additions are the public static modules `/assets/report-export.js` and `/assets/report-bundle.js`, served with the existing CSP, `no-store` and `nosniff` headers; there is no new export API endpoint.

This is a portable execution report, not an approved training dataset. The manifest always sets `training_approval: false` and preserves recorded training classifications. Human confirmation does not approve privacy, redaction, sampling or training use. Fixtures remain excluded; dataset approval and external training uploads remain separate work.

## Command line

From the repository root, with the local stack running:

```sh
just export-report RUN_UUID
```

The command reads the local workspace token from the ignored `.env`, fetches the selected report and runs the same bundle implementation. It prints the export UUID, output path and verified/gap counts. Files are written under `artifacts/run-reports/<export_uuid>/scout-run-<run_uuid>-evidence.zip`. The token is not included in the file or output. This command does not start a browser or call a model.

## Verification

```sh
just web-test
just report-export-test
just web-contract-test
cargo test --locked --manifest-path apps/api/Cargo.toml
```

Pure JavaScript tests cover readable projection, untrusted text, evidence ownership/references, integrity failures, bounds, archive paths, snapshot pinning and cancellation/disconnect behavior. The native Rust suite passes 35 tests; the static module test checks public access, exact embedded source, MIME, CSP and uncached security headers. Clippy passes with warnings denied.

`report-export-test` reads existing local runs and writes [artifacts/report-export/verification.json](./artifacts/report-export/verification.json). It renders stored reports and verifies representative ZIPs with Python's independent standard ZIP reader, including CRC32, path safety, byte lengths, SHA-256, exact manifest membership and a failed-capture gap. It also checks that export does not add model calls or mutate recorded runtime evidence. The final integration rendered 50 reports and checked three archives: an original human-confirmed source, a failed-capture run and a completed replay. The served modules match source and retain the expected security headers. At the default 484 × 724 browser viewport, Markdown and ZIP downloads completed; the actual downloaded ZIP independently passed CRC32 and file-hash checks for all 16 evidence files, with source confirmation retained. The drawer had no horizontal overflow or console errors; Escape closed it and returned focus to Export report. This is a focused local interaction check, not full browser/accessibility coverage. The record and screenshot are [artifacts/report-export/browser-verification.json](./artifacts/report-export/browser-verification.json) and [artifacts/report-export/gui-report-export.jpg](./artifacts/report-export/gui-report-export.jpg).
