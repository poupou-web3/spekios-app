---
{
  "title": "Capabilities and current limits",
  "description": "Check what ScoutQA implements today, including browser actions, model providers, reports, sign-in, replay and deployment limitations.",
  "reviewed": "2026-10-30",
  "sidebar": {
    "order": 5
  }
}
---
Scout is a local developer preview. This page distinguishes implemented behavior from work that still needs to be built or validated.

## Implemented

| Area | Available now |
| --- | --- |
| Input | URL-only exploration of explicitly permitted HTTP(S) origins. |
| Browser | Chromium with desktop, tablet and mobile viewport profiles. |
| Actions | Native navigation, click, text/search fill, single-select, checkbox/radio, document scroll and permitted form submission. |
| Planning | Likely-action ranking, recorded graph/frontier, duplicate avoidance, branch returns, stale-state replanning, controls further down the page, versioned active-run testing focus and [memory across runs](../../guides/app-memory/) with reopening of unfinished pages. Runs allow up to 50 actions and stop after 30 minutes by default. |
| Checks | Pre-action expectations, per-action assessments, exact image differences, sampled completion frames and redacted diagnostics. |
| Findings | Original suspicions, fresh-browser replay, optional bounded automatic replay and append-only human review. |
| Agent identity | User setup page, standard MCP browser OAuth with PKCE/DCR and rotating renewal, native connector compatibility, private history, revocation and token attribution. |
| Access | Human-controlled native same-origin sign-in and optional encrypted session reuse. |
| Models | OpenAI, Anthropic, OpenRouter and Meta AI API-key connections; nullable token/cost accounting. |
| Interfaces | User workspace, operations console, REST API, 26 MCP/HTTP tools and a Rust stdio bridge. |
| Exports | JSON snapshot, Markdown report and verified evidence ZIP. |

## Not implemented yet

- Native mobile apps, Firefox or WebKit coverage.
- Arbitrary JavaScript, custom dropdown/contenteditable controls, file uploads, downloads or iframe interaction.
- General account creation, checkout or unapproved form submissions.
- Google/external OAuth handoff, passkeys or reuse of an ordinary desktop browser’s cookies.
- Subscription login that spends ChatGPT, Claude or coding-agent usage allowances.
- An external observe/act/assess API.
- Source-repository integration, automatic code fixes or source-location inference.
- Human account signup/invitations, hosted identity providers, subscription billing and public community sharing.
- Multiple browser workers, interrupted-action resume or Kubernetes manifests.
- Full tool input/output payload auditing, approved training export or continuous video capture. Route/tool metadata audit is implemented.

## Permanent issue and candidate history

Completed reliable suspicions receive stable issue IDs. Users and agents share a frozen expected/actual handoff, original reproduction path and screenshots. Candidate URL submission queues a fresh-browser verification, preserving both evidence sets and per-run usage. Outcomes are resolved on candidate, still reproducible, blocked or inconclusive. Cancellation, interruption, missing evidence and changed preconditions never count as resolved. See [fix verification](../../guides/fix-verification/).

## Verification boundary

Automated integration uses real Chromium and local storage with simulated model providers. That validates contracts, evidence handling and recovery. Live-model exploration quality and correctness on arbitrary real apps remain separate validation work. Browser OAuth is integration-tested locally; individual vendor apps and external HTTPS deployments still need interoperability validation.

Any public https site can be tested. Its pages run in a separate browser sandbox container that holds no Scout credentials or saved logins and cannot reach Scout's database, evidence store, analytics, API or model gateway. Chromium's own sandbox is on, and the container restarts after every run. See [access and recording boundaries](../../operators/security/) for what the sandbox can still reach.

Explorations act like a user and can change data on the site. Prefer a test account on apps with real data.

For setup problems, use [troubleshooting](../../operators/troubleshooting/).
