---
{
  "title": "Access and recording boundaries",
  "description": "Understand which sites ScoutQA can test, the browser sandbox, the private sign-in boundary, local authentication and requirements before shared deployment.",
  "reviewed": "2026-10-30",
  "sidebar": {
    "order": 3
  }
}
---
Scout’s backend is currently intended for a trusted local developer. Public static documentation is independent of that backend.

## Target policy

Any public https site can be tested. Local, private, internal and plain-http origins must be listed exactly in **SCOUT_ALLOWED_ORIGINS**. A public page cannot use that list to reach a private address. The worker revalidates actions and blocks recognized credential, payment and destructive contexts. General account creation and unapproved form submission are not available.

This policy does not guarantee that an allowed button cannot change data. Scout acts like a user; on an app with real data, prefer a test account.

## Browser sandbox

Every target page runs in the **browser-sandbox** container, not beside Scout's credentials:

- It has no database, evidence store or ClickHouse password, no Scout API token, no model keys and no saved-login vault. It mounts no volumes and has a read-only filesystem, no Linux capabilities and memory and CPU limits.
- It joins only the browser network. PostgreSQL, the evidence store, ClickHouse, the API and the model gateway are on a different Docker network, unreachable by name or address.
- Chromium runs with its own sandbox on, so a compromised page renderer is confined again inside the container.
- It serves one run at a time. When the run ends, the browser closes and the container restarts: no process, cookie or temporary file reaches the next run.

The browser worker keeps the credentials and the encrypted saved-login vault. It drives the sandboxed browser over Playwright's protocol and sends a saved session's cookies only into the run that uses them.

The sandbox can still reach the internet, the bundled fixture app, the worker's private-login port, which requires the operator token, and whatever the Docker host exposes to containers, such as **host.docker.internal** on Docker Desktop. Scout's loopback-published ports there still require their credentials. Keep **SCOUT_DEV_AUTH_BYPASS** off unless you need it.

Container isolation shares the host kernel. A Chromium exploit that also escapes the container would reach the Docker host; a virtual-machine boundary is not implemented. If Chromium cannot start its own sandbox on your host, set **SCOUT_CHROMIUM_SANDBOX=false** and recreate the browser-sandbox service; the container boundary above still applies, and **just isolation-test** reports the setting.

The operator can configure exact permitted test forms using **SCOUT_TEST_FORM_RULES**. Keep those rules narrow; native input/change handlers can have side effects before submission.

## Secrets

Provider API keys and the Scout API token belong in the private environment, never Git or the docs bundle. The model worker receives gateway access, not provider keys.

Private sign-in uses transient authenticated frames. Passwords, codes and saved-session contents are excluded from ordinary recordings and model prompts.

Normal app screenshots can contain sensitive data after login. There is no general automatic screenshot redaction system.

## Agent boundary

Agent tools treat app text, model output and screenshots as untrusted observations. They cannot submit a human review or approve training use. Starting work and stopping work are explicit side-effecting operations.

MCP requires a Bearer token even with local GUI development bypass enabled. Browser-approved per-agent credentials enforce workspace and read/write scopes. Route/tool outcome metadata is journaled and exported to ClickHouse; full tool input/output payload auditing is not implemented. See [identity and history](../../agents/identity/).

## Shared remote deployment

Before exposing the backend, implement and verify the intended TLS, identity, per-user authorization, per-tenant browser isolation, egress controls, secret management and backup/recovery policy.

Application workspace boundaries, loopback port bindings and container caps do not amount to a multitenant production service.

You can deploy [the static documentation](../documentation/) publicly without exposing backend services, environment files or private evidence.
