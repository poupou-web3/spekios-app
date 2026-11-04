---
{
  "title": "Connect your agent",
  "description": "Connect an agent app to Spekios with a server URL and browser approval. No repository, build command, developer connector or pasted secret is required for compatible HTTP MCP clients.",
  "reviewed": "2026-11-04",
  "sidebar": {"order": 2}
}
---
Open **Connect your agent** in your Spekios workspace. Choose your agent app, copy the connection URL into that app’s MCP settings, then approve the connection in your browser. You do not need the Spekios source code, **just**, an extension or CI/CD.

Spekios’s thirty-four tools let your agent submit a URL, check progress, retrieve a report, triage findings, verify fixes and find related tests later. You can follow the same runs and evidence in the Spekios workspace.

For a terminal agent, use the [standalone CLI](../cli/). It supports browser approval, project selection, JSON output and durable job retries without a repository checkout.

## Connect from an agent app

1. Open **/connect** on your Spekios server: **https://app.spekios.com/connect** for the hosted app, or **http://127.0.0.1:18080/connect** for a local installation.
2. Choose your app and copy the displayed **Spekios connection URL**. It contains no secret.
3. Add Spekios as a **Streamable HTTP** MCP server in the agent app. Choose browser authorization when prompted.
4. The app opens Spekios’s approval page. Check the app name, workspace, return address and requested permissions, then choose **Allow connection**.
5. Return to the agent. Ask it to check **scout_whoami**, then test your URL.

Opening the page does not grant access. The agent app exchanges a one-use authorization code with its own PKCE verifier and keeps its credentials in its own credential store. Spekios never puts an agent token in the setup page, prompt or tool result.

The workspace page shows **Approved · waiting for first use** until an authenticated agent request is recorded. **Connected** means the credential has been used; it is not a live connection or service-health probe. Disconnect an agent there to prevent future requests and token renewal. Already queued tests continue until separately cancelled.

## Choose a client

### Muse Code (Meta)

Muse Code, Meta’s terminal coding agent, reads MCP servers from **~/.config/muse/settings.json**. Add Spekios under `mcp_servers` (keep your other settings; the file needs `"schema_version": 1`):

```json
{
  "schema_version": 1,
  "mcp_servers": {
    "spekios": { "transport": "streamable_http", "url": "https://app.spekios.com/mcp" }
  }
}
```

Use the connection URL from the setup page. Then run `muse mcp login spekios`: your browser opens Spekios’s approval page, and Muse Code stores and refreshes the credential. In a `muse` session, `/mcp` lists the connected servers and their tools. Muse Code registers itself automatically (dynamic client registration), which Spekios supports. Because Muse Code runs on your computer, it can also connect to a Spekios server at **localhost**. See [Meta’s MCP instructions for Muse Code](https://dev.meta.ai/docs/muse-code/extending#mcp).

### Codex and ChatGPT desktop

Open the app’s **Settings → MCP servers → Add server**, choose **Streamable HTTP**, name it **Spekios** and paste the connection URL. Save and restart/reconnect as the app requires, then select **Authenticate**. Codex clients share MCP configuration for the same host. See the [official OpenAI MCP instructions](https://learn.chatgpt.com/docs/extend/mcp?surface=app).

This is a direct desktop MCP connection. ChatGPT web has its own plugin setup; it does not read a local Codex configuration.

### Claude account connectors

Open **Customize → Connectors → Add custom connector**, enter **Spekios** and the connection URL, then connect with browser sign-in. If asked to choose an OAuth client, select **Register automatically**. Spekios supports dynamic client registration; client metadata documents are not supported.

Claude’s account connectors connect from Anthropic’s cloud, including when configured in Claude Desktop. They cannot reach a Spekios server running only at **localhost**. Use a publicly reachable HTTPS Spekios deployment for this path. Native local MCP configurations are a separate option. See [Claude’s connector instructions and network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### Another agent app

Use a client supporting Streamable HTTP, protected-resource discovery, dynamic client registration, authorization code with PKCE S256 and resource indicators. The connection URL ends in **/mcp**. The setup page supplies it for the current server; there is no per-user token in this URL.

## Give your agent a task

~~~text
Use Spekios to test https://my-app.example.
Check my workspace identity and relevant previous runs first.
Start a new test when needed, follow progress, and return findings
with expected vs. actual behavior and screenshot evidence.
If access is needed, ask me to sign in through Spekios.
~~~

The setup page also generates this prompt with an optional URL. Install the [lightweight skill](../skill/) if your client supports skills; it is optional. The model used by Spekios remains the workspace’s configured provider. Connecting an agent does not transfer a ChatGPT or Claude subscription allowance to Spekios.

## Access and expiry

The person approving must be signed in to the Spekios workspace. On the hosted app that is a Spekios account; a local installation uses its own sign-in or the explicitly enabled development bypass. Workspace membership invitations are not supported.

Agents receive only requested **runs:read**, **runs:write** and **usage:read** permissions. They cannot approve peers, change workspace settings or submit human reviews. Read-only report requests make no model calls; starting tests or reproductions can change the controlled app and consume model usage.

OAuth access tokens last at most one hour. Rotating refresh tokens preserve the same agent identity within a thirty-day connection; reconnect after that. Reusing a refresh token revokes that OAuth connection. OAuth access tokens are bound to this server’s **/mcp** audience and cannot authenticate ordinary REST routes. Native connector and CLI credentials work for REST integrations.

## Native development connector

Developers working from a Spekios checkout can also use the native stdio connector:

~~~sh
just mcp-login
just mcp-config
~~~

It opens a code approval at **/connect**, stores a private credential at **~/.config/scout/credentials.json** and prints a stdio configuration containing file paths. This path is optional and requires the checkout and Rust build tools. **scout-mcp logout** revokes that credential and removes its file.

Use **--api-url**, **--credential-file** and **--no-browser** for explicit native profiles. Existing **--env-file** and **SCOUT_API_TOKEN** access remains privileged operator compatibility; do not distribute an operator token to ordinary agents.

## Self-hosting the connection

An operator supplies the running Spekios service. Local app connections can use literal loopback HTTP. For remote clients, set **SCOUT_PUBLIC_ORIGIN** to the exact HTTPS origin and preserve Host through the TLS reverse proxy. Forwarded headers do not enroll a new origin; setting a public origin disables anonymous development access.

The default Compose installation stays bound to loopback. Connecting agents does not set up a public deployment, tunnel or TLS for you. Review [deployment security](../../operators/security/) before exposing a shared service. Read the [OAuth API contract](../../api/authentication/) for discovery and token endpoints.
