# Code review and cleanup

Reviewed on 2026-10-29 across the Rust API and MCP layer, browser execution and persistence, image differences, user and operations interfaces, documentation, and local development tooling.

## Fixed

- The legacy recorder supplied three values to a five-parameter run insert. It now supplies the owning workspace and user as well as the target URL and configuration. Browser tests assert ownership and complete recording, including evidence recovery and unknown interrupted outcomes.
- Workspace HTTP requests now share a local-path fence, timeout, cancellation, credential headers, redirect policy and structured error handling. Foreign or ambiguous destinations are rejected before fetch. Each interface keeps its own session and rendering behavior.
- The documentation HTTP checker still expected an old fixed page count. Published pages and tool references are now checked against the actual sources and catalog, so adding a guide does not require changing unrelated assertions.
- Cleared Rust Clippy findings in authentication, auditing and OAuth parameter parsing, and removed an unused installer import.

## Simplified

- Extracted stored run projections into `apps/api/src/runs.rs`. MCP reads the stored JSON directly while retaining its response-size limit, error contract and workspace scope.
- Extracted MCP tool schemas into `apps/api/src/agent/catalog.rs`, keeping tool definitions separate from execution. The exported catalog and documentation remain identical.
- Replaced repeated JavaScript asset handlers with one explicit embedded allowlist. Unknown assets and traversal attempts return 404; no request path is read from disk.
- Shared browser transport in `apps/web/workspace-http.js`; VM tests evaluate that actual implementation through one source loader.
- Shared ClickHouse outbox delivery and acknowledgement in the worker. Runtime, identity and issue events keep their existing projections and immutable event IDs. Export failure leaves rows pending; acknowledgement failure retries identical event bytes.
- Named the candidate verification path-completion checks and replaced loose boolean casts with a type guard. A fix still requires a positive observation under the recorded preconditions.
- Derived documentation tool labels and inventory checks from their catalog and sources instead of duplicated constants.

This cleanup adds no dependencies or database migrations. Existing issue IDs, evidence references, nullable usage, private workspace access and conservative verification outcomes are retained.

## Validation

| Check | Result |
| --- | --- |
| Rust format and Clippy, all targets with warnings denied | Passed |
| Rust API and native bridge tests | 61 passed |
| Web tests | 120 passed |
| Browser runtime TypeScript | Passed in the recorder container |
| Browser integration outside the legacy recorder file | 90 passed |
| Legacy recorder tests, rerun after fixing the insert | 12 passed |
| Issue discovery → coding handoff → candidate verification | 17 end-to-end checks passed |
| Normal-mode HTTP MCP and native stdio compatibility | Passed; no inference |
| OAuth lifecycle, isolation and ClickHouse audit | 10 checks passed; no inference |
| Image differences | 12 passed |
| Local development scripts | 7 passed |
| Skill installer | 7 passed |
| Documentation builds and tests | Default, public root and public `/scout/` passed, 9 tests each |
| Astro diagnostics and API documentation contract | No diagnostics; catalog and 56 operations match the compiled router |
| Documentation served by Nginx | 24 HTTP cases passed |
| GUI browser checks | Workspace, back office, issue history and agent setup loaded |
| Whitespace errors | `git diff --check` passed |

The first complete browser run exposed the recorder insert failure; its 12-case file was rerun successfully after the fix. The other 90 browser cases passed in the complete run. Browser evidence is real Chromium; model responses in integration tests are controlled fixtures, not a measurement of live model quality.

Screenshots from the GUI checks are under `artifacts/refactor/`. Integration results are under `artifacts/fix-verification/` and the OAuth/interface validation artifacts.

## Boundaries

The stateful exploration and browser-safety logic remains in place. This pass reduces duplication around it and validates its current behavior; it does not claim exhaustive security coverage or validate third-party model quality. Changes were left uncommitted alongside the existing work.

## Follow-up regression review

The complete 102-case browser suite now passes in one run, including the recorder. Additional delayed-response tests exposed GUI bugs that the earlier synchronous tests missed:

- **Consent could target the wrong agent.** Changing an OAuth request or native pairing code left the old consent visible while loading the new request; an older response could then overwrite the displayed agent. Approval now captures the exact displayed request, disables consent during loading, and ignores obsolete lookups. A new connection arriving during a pending decision is reviewed afterward and still requires its own decision.
- **Expired or changed workspace access could leave stale UI.** A cached manager identity kept the connection page open after a 401. Requests now recheck the current credential after reading the body, and expired access hides the private interface and returns to sign-in.
- **Issue navigation and history could become stale.** Navigation was ignored during polling/submission, and older detail or search responses could replace newer results. Navigation now updates immediately; response generations prevent stale renders and mixed history. A submission's receipt remains associated with its original issue.
- **Switching issues could lose an uncertain submission's retry ID.** All issues used one session-storage slot. Pending checks now use a slot per issue, migrate the previous format, and retain the same candidate and command ID when revisiting an uncertain check. An in-flight command cannot be discarded accidentally.

Seven failing scenarios were reproduced before their fixes. Eleven regression tests were added. These checks establish the defects and fixes in the current code; they do not attribute every defect to the preceding extraction refactor.

Final verification: 61 Rust tests, 131 web tests, all 102 browser-runtime tests, 17 issue-to-fix journey checks, 10 OAuth lifecycle checks, normal-mode HTTP/stdio MCP checks, 12 image-difference tests, 7 local-script tests, 7 installer tests and 9 documentation tests passed. Clippy and whitespace checks are clean. Integration model responses are simulated; browser execution and stored screenshots are real. The rebuilt application was checked in the browser and the local services were restored to normal mode with no active work.

Changed implementation: `apps/web/connect.js`, `apps/web/issues.js`. GUI proof is in `artifacts/regression-review/`.
