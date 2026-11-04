# Conditional computer-use recovery

When exploration runs out of usable native controls, a Meta model can recover
with its native Responses `computer` tool. This is not desktop access or
arbitrary automation. Direct `muse-spark-1.3` and `muse-wonder-1.0` support it
([Meta docs](https://dev.meta.ai/docs/computer-use)). Other Meta model IDs,
such as `-contributor` variants, need the permission set explicitly and a
successful check; other providers, OpenRouter included, cannot use it.

Saved models accept optional `computer_use` permission. Omission defaults on
only for the two documented direct models. `resolve_model` resolves the flag
after project/run precedence; jobs freeze it. Key binding disables an unverified
connection. Gateway admission independently enforces the frozen flag and exact
connection. Native requests use the same key, budget reservation, dispatch
journal, cancellation and token settlement as text decisions.

Signed-in people (not agent credentials) can POST `/v1/computer-use/check` with a UUID, provider/model and saved
key reference. The server builds the entire probe: no user prompt, run, captures
or executable action. Poll the existing request record. A successful native
envelope, with matching returned model, proves protocol support; a textual claim
does not. The existing request/call ledger holds proof, scoped to workspace,
user, resolved funding/key and execution mode, expiring after 30 days. GET `/v1/model-providers` shows successful
checks to managers only. Saving defaults never triggers a check.

Recovery is considered after a pre-dispatch native-control failure or an empty
reachable frontier. It does not blindly repeat a dispatched action. A native
decision must contain exactly one supported gesture and no pending safety
checks. A separate prediction is recorded before execution. The runtime reuses
normal action recording, settling, diffing and assessment; earlier suspicions
are never erased. Native output rejection disables recovery locally and leaves
normal exploration available.

Bounds: six attempts/run, three/URL, one per screenshot SHA-256, and the existing
action/time/model-call/usage limits. Only left click, move/hover, wheel scroll and
explicit draggable/slider/scrollbar drag are implemented. Fresh DOM hit tests
reject sensitive, form, disabled, destructive and cross-origin targets. Drag
paths are bounded and checked point by point. Text/keypress, unknown fields,
unbounded coordinates and action batches are rejected. Private-login capture
boundaries and browser network isolation remain in effect.

Coordinate commands bind to an exact screenshot SHA-256. A fresh before capture
must match, including in replay and candidate verification. Recovery commands
are not stored as reusable navigation routes or cross-run action rankings.
Replays execute recorded gestures only, without native model calls. A disabled
permission or changed visual precondition yields incomplete verification, never
an assumed fix.

Tests: `SCOUT_TEST_TOOLCHAIN=1.96.0 bash scripts/test-computer-use.sh` runs
disposable PostgreSQL, a real API/gateway and Chromium against a local model/S3
fixture. It exercises native probes, rejected text claims, account isolation,
real nested scroll evidence, usage, refusal/safety checks, disabled recovery and
the live settings UI. `SCOUT_COMPUTER_BROWSER_TEST=1` enables driver tests for
scroll, hover, drag and guarded targets. No live provider credentials are used.
