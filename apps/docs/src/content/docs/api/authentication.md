---
{
  "title": "Authentication and access scope",
  "description": "Authenticate ScoutQA REST and MCP with workspace-bound agent credentials, understand manager and operator access, and protect local connection secrets.",
  "reviewed": "2026-10-29",
  "sidebar": {"order": 2}
}
---
Protected REST and MCP requests use **Authorization: Bearer** with an issued credential. OAuth credentials are restricted to **/mcp**; native connector credentials can use the REST API. [Browser pairing](../../agents/connect/) connects a local agent without sharing the operator token. **GET /v1/identity** returns its workspace, identity and permissions without exposing its secret.

## Browser OAuth for MCP clients

The user-facing [connection page](../../agents/connect/) supports an HTTP MCP client without a checkout or a custom executable. **GET /v1/agent-setup** returns the public connection URL and whether the operator configured a hosted HTTPS origin. It does not test external reachability.

| Endpoint | Purpose |
| --- | --- |
| GET /.well-known/oauth-protected-resource/mcp | MCP resource URI, authorization server and supported scopes. The root well-known URI is also available. |
| GET /.well-known/oauth-authorization-server | Issuer and authorization, token, registration and revocation endpoints. |
| POST /oauth/register | JSON dynamic registration of a public client using **token_endpoint_auth_method=none**. |
| GET /oauth/authorize | Validate client, registered redirect, resource, scopes and PKCE; redirect to human approval. |
| GET /v1/oauth/authorizations/{id} | Manager-only pending request details. |
| POST /v1/oauth/authorizations/{id}/decision | Explicit approval or denial; return the registered callback to the human browser. |
| POST /oauth/token | Form-encoded authorization-code exchange or rotating refresh. |
| POST /oauth/revoke | Form-encoded revocation with **client_id** and **token**. |

MCP 401 responses advertise **resource_metadata**. Only authorization code with **S256** is accepted. **resource** must equal the canonical server URL ending in **/mcp**, in both authorization and token requests. Redirect URIs match registration exactly except the port of the same native loopback callback. Invalid request redirects are rejected without navigating. OAuth responses include the issuer and preserve the client’s state. Duplicate parameters are rejected.

Authorization requests expire after ten minutes; an approved code expires after two minutes and can be exchanged once. Access tokens last at most one hour. Refresh rotates within a fixed thirty-day connection, preserves the agent identity, and revokes the connection on reuse. Code, access and refresh secrets are stored as hashes. Browser approval never returns an access/refresh token. Dynamic registration is bounded to 1,000 clients per hour globally and pending authorizations to 100; these bounds do not replace hosted abuse controls.

Client metadata document URLs, confidential-client secrets, implicit grants and cross-origin browser JavaScript access are not supported. A client should choose automatic registration, not published identity. The existing [native pairing](#pairing-endpoints) is a separate protocol and remains compatible.

## Native agent credentials

The connector saves a private credential file and supplies its header automatically. Tokens last thirty days, are stored as hashes on the server and can be revoked at **/connect**. Direct HTTP clients should use their own local secret mechanism. Do not put tokens in URLs, skill files, client configuration examples, reports or chat.

Agents receive a subset of **runs:read**, **runs:write** and **usage:read**. Workspace ownership is derived from the authenticated credential on every request. User-supplied correlation UUIDs cannot switch teams. See [identity and private history](../../agents/identity/) for the ownership and audit model.

## Pairing endpoints

**POST /v1/agent-connections** accepts an agent name, requested scopes and a SHA-256 verifier challenge. It returns a ten-minute device code, public approval code and **/connect** browser path. The connector keeps the device code and verifier private.

A workspace manager reviews **GET /v1/agent-connections/{code}** and explicitly approves or denies through **POST /v1/agent-connections/{code}/decision**. **POST /v1/agent-connections/token** exchanges the device code and verifier after approval. Pending polls use HTTP 202, excessive polling 429, denied requests 403, and consumed grants 409. A token is returned once; an uncertain final exchange needs a new pairing. This native pairing protocol is separate from the standard MCP OAuth endpoints above.

## Managers and the trusted local operator

Managers approve/revoke agents and use the human workspace. The operator can provision a private workspace with **POST /v1/workspaces**, receiving its manager credential once. Human signup, membership invitations, account recovery and subscription payments remain future work.

The existing **SCOUT_API_TOKEN** from the ignored checkout environment remains privileged operator/worker access. It is not an ordinary agent credential. Provider keys belong only in the server environment.

## Development bypass and public status

**SCOUT_DEV_AUTH_BYPASS=true** explicitly opens the local developer GUI and ordinary protected routes only for accepted loopback/same-origin requests. It is off in source defaults. A bad presented credential is never replaced by bypass access. MCP always requires an explicit credential.

**GET /healthz** reports process health. **GET /v1/auth-mode** tells the local GUI whether sign-in is needed. In bearer-token mode the workspace asks for an email and password. **POST /v1/workspace-login** accepts email `admin` and the **SCOUT_API_TOKEN** value as the password; the browser then keeps that password as its bearer credential for the tab. The response contains no secret. **GET /readyz** is protected. Public pairing endpoints issue no access before manager approval. No CORS access is enabled.

For remote browser approval behind TLS, configure **SCOUT_PUBLIC_ORIGIN** as the exact HTTPS origin and preserve Host at the reverse proxy. Forwarded headers do not add trusted origins; this setting disables the anonymous development bypass. The Compose deployment binds the API to loopback. Workspace isolation is an application access boundary; TLS, human identity, restricted network egress, browser sandboxing and resource isolation still need a reviewed deployment before exposing shared hosting publicly.
