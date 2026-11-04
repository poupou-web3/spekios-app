---
{
  "title": "Agent identity and private history",
  "description": "Understand persistent agent identities, workspace permissions, domain and task history, credential revocation and usage attribution in Spekios.",
  "reviewed": "2026-11-04",
  "sidebar": {"order": 3}
}
---
A workspace owns its testing data. Each connected agent has a stable agent UUID and its own credential, so a new conversation can retrieve previous work without starting another test. [Connect through browser approval](../connect/).

## Find related sessions

**scout_whoami** returns the workspace, agent and credential reference, permissions and **team_private** visibility. It never returns a token.

**scout_list_sessions** searches the full accessible run history. Filter by an exact **domain**, normalized **url**, **agent_id**, **project_id** or **task_id**. Use **offset** and **limit** and follow **pagination.next_offset**. Offset pagination is not a frozen snapshot: newly created runs can move results, so deduplicate by run UUID. The current offset bound is 100,000.

**scout_get_domain_summary** requires **domain** and returns the latest twenty matching runs, the matching history count and coverage caveats. Domain means the exact hostname; subdomains and different hosts are not silently combined. URL queries remain part of an exact URL filter.

An exploration can optionally receive **project_id** and **task_id** UUIDs. These are caller-managed correlation labels, not project accounts or permission grants. Save a task ID across related attempts and a project ID across an application's tests. They do not replace the stable **job_id** used for command retries. Automatic reproductions inherit the source admission's labels and submitting agent.

**scout_list_runs** only searches the latest fifty runs; use the session-history tools for older ones. Jobs which have not created a run yet are available through job/progress tools.

## Permissions and ownership

Agents in one workspace can read its runs when granted **runs:read**. Starting tests, reproductions, fix verifications and rechecks, triage, testing-focus changes and cancellation require **runs:write**; token/cost totals require **usage:read**. These checks apply to HTTP tools, MCP tools, ordinary REST routes and evidence downloads.

The server derives ownership from the credential. Guessing another workspace, run, capture or artifact UUID never grants access. Agent credentials cannot submit human reviews, approve new agents, change model settings, control private login frames or submit raw model requests.

Browser OAuth renewals retain the same agent UUID. The dashboard groups rotating credentials into that one connection; expiry and revocation apply to the connection.

A workspace manager approves and revokes agents. On the hosted app, the signed-in account owner manages their workspace. On a self-hosted server, the operator can also provision a workspace with **POST /v1/workspaces**, receiving a thirty-day manager credential once. Workspace membership invitations are not supported. The operator token remains privileged infrastructure access and must not be handed to agents.

## Attribution and audit

Browser admissions record the submitting agent. Run configuration keeps **submitted_by_agent_id**, distinct from the runtime worker's internal **agent_id**. Model requests inherit the submitting identity from the linked run's admission. **scout_usage** includes **by_agent** known token and provider-reported cost totals; absent usage stays unknown.

PostgreSQL stores credential hashes and authoritative identity/audit records. A retryable outbox exports route/tool names, credential references, request UUIDs, start/outcome events and timestamps to ClickHouse. **scout.identity_audit_current** deduplicates events and **scout.agent_model_usage** attributes model-call telemetry. Requests are rejected before work if their initial audit cannot be persisted. If completion auditing fails, the started event remains and a response header reports the gap. Credentials, approval secrets, private login input and tool request/response bodies are excluded from identity audit payloads. Existing model-call request/response journaling remains separate.

Revocation prevents future authenticated requests. Already admitted jobs continue until separately cancelled. Reports and evidence are retained.

## Runs stay private

Runs and evidence are private to the workspace. Public reachability of a target does not make its screenshots, entered data or findings public, and domain search only returns the caller's workspace data. There is no public or shared community mode.
