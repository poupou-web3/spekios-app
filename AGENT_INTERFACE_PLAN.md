# Agent control interface

The priority is an interface through which another agent can operate Scout and inspect its results. The GUI remains a view of the same durable state.

**28 October 2026:** the first increment is implemented and verified through HTTP MCP, plain HTTP and a real Rust stdio subprocess. A simulated-provider workflow exercised exploration, evidence reads, reproduction and cancellation against the real browser/storage stack. Normal services were restored; normal-mode reads added no inference or browser actions. See [connection instructions and limits](./AGENT_INTERFACE.md). The following increments remain open.

## First working increment

Implement in the Rust API using the official Rust MCP SDK:

- An authenticated Streamable HTTP MCP endpoint at `/mcp`, plus a local stdio bridge for clients that launch a subprocess.
- A discoverable plain HTTP tool catalog and invocation endpoint for agents without MCP support.
- Tools to start URL-only exploration, poll one durable job, inspect runs/findings/actions/graph/events, read recorded evidence, reproduce a candidate, cancel work, inspect usage and identify pending human sign-in requests.
- A caller-supplied job UUID for commands that can launch browser/model work. Retrying the same command retains the existing admission semantics.
- Compact, bounded results with stable action/capture/artifact IDs. Recorded screenshots return MCP image blocks; private sign-in frames and credentials are not exposed.
- Reuse the existing API handlers, scoped database reads, queue, cancellation and evidence integrity checks. No second browser executor or model adapter.

The MCP endpoint always requires the existing bearer token, including when GUI development sign-in is bypassed. It validates browser origins and retains loopback host protection. The stdio bridge reads its token from an environment variable or an explicitly selected `.env` file; it never prints credentials or mixes logs into protocol stdout.

Verify with protocol initialization/tool discovery, an actual stdio client, private recorded screenshots and a complete simulated-provider explore → poll → inspect → cancel/reproduce workflow. Tests must make no live provider calls. Preserve all existing recordings.

## Coding-agent feedback workflow

The primary agent contract is asynchronous QA feedback for an agent with a codebase: submit a URL, continue other work, pull lightweight progress, then retrieve an expected-versus-actual report and use its evidence to investigate and fix the application.

Implemented in this increment:

- scout_get_progress and ordinary job/run progress endpoints return phases, observed counts, user blockers and the report reference without loading the full graph/evidence payloads.
- scout_get_report and job/run report endpoints assemble recorded bugs, ordinary changes, execution problems, browser signals and uncertain checks into JSON plus Markdown.
- scout_get_issue and a run/action endpoint expose individual repair handoffs with routes/control labels, frozen expectations, observed outcomes, the recorded action prefix, diagnostics, screenshot/mask/artifact references, independent reproduction and separate human decisions.
- Report continuation calls bind to the recorded snapshot hash. A changing snapshot returns 409 and requires restarting pagination.
- The report supplies behavior to validate and code-search clues; it does not invent code locations, deployment commits or root causes. Permanent issue IDs now link that handoff to candidate deployment verification in a fresh browser. Users and agents share the same history, original/candidate evidence and per-run usage. Resolved requires positive expected behavior; drift, cancelled/interrupted work and incomplete evidence remain inconclusive or blocked. Ordinary reproduction and human review stay separate.

Verification passed with 53 Rust tests, 96 UI tests, real-browser simulated-provider exploration/reproduction, stdio submission followed by disconnect and HTTP reconnection, partial progress, actionable zero-pixel failure reports, healthy save changes, owned evidence retrieval and snapshot-bound report paging. Normal-mode report reads added no model calls or browser actions.

Versioned active-run steering is implemented through GUI, HTTP and MCP, with acknowledgement at planning admission. Direct browser driving remains a later capability. They are not prerequisites for this feedback-and-fix workflow.

## Following increments

1. **Steering — implemented:** revision-checked focus changes, stable command IDs, agent attribution, bounded history and durable pending/applied/superseded/not_applied states. The next planning decision includes the active focus; cached branch rankings yield to fresh scores. Current actions and replay paths retain their frozen expectations. GUI, progress, reports, HTTP and MCP expose acknowledgement. ClickHouse receives runtime events.
2. **External browser driver:** observe/act/assess commands so a connected agent can supply its own model decisions. Require fresh observation IDs, frozen expectations, scoped typed actions and the existing complete evidence chain. This is separate from starting Scout's autonomous explorer.
3. **Agent identity and audit:** per-agent credentials/scopes, revocation, caller attribution, tool-call input/output records and ClickHouse delivery. The first increment retains the existing single local developer token and durable command/evidence records; it does not claim a complete MCP-read audit trail.
4. **Push and subscriptions:** durable event cursors first, then live subscriptions/notifications with reconnect behavior. A disconnect must not silently cancel a durable browser job.
5. **Hosted access:** workspace membership, remote authentication, network isolation, quotas and a reviewed public deployment configuration.

Agents may inspect human reviews but cannot submit a machine decision as a human confirmation through these tools. Private app sign-in remains a user handoff. Starting or reproducing a run uses the configured Scout provider and can consume its model allowance; exposing tools is not subscription authentication.


## Browser pairing and private workspace identity — 29 October 2026

Implemented: persistent per-agent credentials, browser approval with verifier-bound one-time grant, thirty-day expiry and revocation; private local connector profiles; explicit per-request workspace scope through API/MCP, queue, browser worker, screenshot/model object storage and replay; full-history domain/URL/task/project/agent filters; agent-attributed usage; route/tool metadata audit outbox to ClickHouse. Existing local recordings retain ownership and privacy. `just identity-test` checks two workspaces with simulated providers. User login/membership, public community projections, billing and quotas remain separate work. Standard HTTP MCP OAuth discovery, DCR, PKCE S256, browser consent, rotating refresh and resource-bound access are now implemented; the native connector stays compatible. Public mode must never follow automatically from a target lacking authentication.
