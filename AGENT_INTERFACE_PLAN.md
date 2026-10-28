# Agent control interface

The priority is an interface through which another agent can operate Scout and inspect its results. The GUI remains a view of the same durable state.

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

## Following increments

1. **Steering:** versioned agent messages and goal corrections, acknowledged at safe worker boundaries. Record whether a message was applied, superseded or arrived after the run ended. Avoid pretending that storing a note changes the planner.
2. **External browser driver:** observe/act/assess commands so a connected agent can supply its own model decisions. Require fresh observation IDs, frozen expectations, scoped typed actions and the existing complete evidence chain. This is separate from starting Scout's autonomous explorer.
3. **Agent identity and audit:** per-agent credentials/scopes, revocation, caller attribution, tool-call input/output records and ClickHouse delivery. The first increment retains the existing single local developer token and durable command/evidence records; it does not claim a complete MCP-read audit trail.
4. **Push and subscriptions:** durable event cursors first, then live subscriptions/notifications with reconnect behavior. A disconnect must not silently cancel a durable browser job.
5. **Hosted access:** workspace membership, remote authentication, network isolation, quotas and a reviewed public deployment configuration.

Agents may inspect human reviews but cannot submit a machine decision as a human confirmation through these tools. Private app sign-in remains a user handoff. Starting or reproducing a run uses the configured Scout provider and can consume its model allowance; exposing tools is not subscription authentication.
