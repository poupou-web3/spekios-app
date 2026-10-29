---
{
  "title": "Access and recording boundaries",
  "description": "Understand ScoutQA’s controlled-target scope, private sign-in boundary, local authentication and requirements before shared deployment.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 3
  }
}
---
Scout’s backend is currently intended for a trusted local developer testing controlled applications. Public static documentation is independent of that backend.

## Target policy

The operator explicitly configures exact permitted origins. The worker revalidates actions and blocks recognized credential, payment and destructive contexts. General account creation and unapproved form submission are not available.

This policy is not a complete sandbox for malicious websites or an assurance that an allowed button cannot change data. Use a controlled app and disposable test data.

The operator can configure exact permitted test forms using **SCOUT_TEST_FORM_RULES**. Keep those rules narrow; native input/change handlers can have side effects before submission.

## Secrets

Provider API keys and the Scout API token belong in the private environment, never Git or the docs bundle. The model worker receives gateway access, not provider keys.

Private sign-in uses transient authenticated frames. Passwords, codes and saved-session contents are excluded from ordinary recordings and model prompts.

Normal app screenshots can contain sensitive data after login. There is no general automatic screenshot redaction system.

## Agent boundary

Agent tools treat app text, model output and screenshots as untrusted observations. They cannot submit a human review or approve training use. Starting work and stopping work are explicit side-effecting operations.

MCP requires a Bearer token even with local GUI development bypass enabled. Browser-approved per-agent credentials enforce workspace and read/write scopes. Route/tool outcome metadata is journaled and exported to ClickHouse; full tool input/output payload auditing is not implemented. See [identity and history](../../agents/identity/).

## Shared remote deployment

Before exposing the backend, implement and verify the intended TLS, identity, per-user authorization, worker isolation, egress controls, secret management and backup/recovery policy.

Application workspace boundaries, loopback port bindings and container caps do not amount to a multitenant production service.

You can deploy [the static documentation](../documentation/) publicly without exposing backend services, environment files or private evidence.
