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
| Planning | Likely-action ranking, recorded graph/frontier, duplicate avoidance, branch returns, stale-state replanning, controls further down the page, versioned active-run testing focus and [memory across runs](../../guides/app-memory/) with reopening of unfinished pages. An [app map](../../guides/app-memory/#the-app-map) of states and transitions carried between runs and compared run to run. Each run [shares its actions](../../guides/exploration-strategy/) between new territory, deep journeys and re-walks of the map, with depth and coverage reported per level. [Fewer model calls](../../guides/exploration-cost/): unchanged screens reuse earlier rankings, and an optional cheaper model handles navigation. No action, time, token or cost limit unless a user [sets one](../../guides/exploration-limits/). |
| Checks | Pre-action expectations, per-action assessments, exact image differences, sampled completion frames and redacted diagnostics. |
| Findings | Original suspicions, fresh-browser replay, optional bounded automatic replay and append-only human review. |
| Triage | Bug, intended behavior, duplicate or needs review, decided by people, agents or Scout; later runs recognize known behavior by page, control, viewport and sign-in state. See [triage and rechecks](../../guides/triage/). |
| Rechecks | Verify a deployment against every open issue of a site (up to 25), from the workspace, an agent or CI with exit codes. |
| Agent identity | User setup page, standard MCP browser OAuth with PKCE/DCR and rotating renewal, native connector compatibility, private history, revocation and token attribution. |
| Access | Human-controlled native same-origin sign-in and optional encrypted session reuse. |
| Models | OpenAI, Anthropic, OpenRouter and Meta AI API-key connections; nullable token/cost accounting. |
| Interfaces | User workspace, operations console, REST API, 32 MCP/HTTP tools and a Rust stdio bridge. |
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
- Kubernetes manifests. Several browser slots share the queue, and an interrupted exploration continues in a new run up to three times. A dispatched action is not repeated. Private sign-in is still one login at a time.
- Full tool input/output payload auditing, approved training export or continuous video capture. Route/tool metadata audit is implemented.
- A built-in recheck scheduler, workspace spend budgets, hand-written test cases or a chat-style session view. Run [scripts/scout-recheck.mjs](../../guides/triage/#recheck-after-a-deploy) from CI or cron for scheduled rechecks.

## Permanent issue and candidate history

Completed reliable suspicions receive stable issue IDs. Users and agents share a frozen expected/actual handoff, original reproduction path and screenshots. Candidate URL submission queues a fresh-browser verification, preserving both evidence sets and per-run usage. Outcomes are resolved on candidate, still reproducible, blocked or inconclusive. Cancellation, interruption, missing evidence and changed preconditions never count as resolved. See [fix verification](../../guides/fix-verification/).

## Verification boundary

Automated integration uses real Chromium and local storage with simulated model providers. That validates contracts, evidence handling and recovery. Live-model exploration quality and correctness on arbitrary real apps remain separate validation work. Browser OAuth is integration-tested locally; individual vendor apps and external HTTPS deployments still need interoperability validation.

Any public https site can be tested. Its pages run in a separate browser sandbox container that holds no Scout credentials or saved logins and cannot reach Scout's database, evidence store, analytics, API or model gateway. Chromium's own sandbox is on, and the container restarts after every run. See [access and recording boundaries](../../operators/security/) for what the sandbox can still reach.

Explorations act like a user and can change data on the site. Prefer a test account on apps with real data.

For setup problems, use [troubleshooting](../../operators/troubleshooting/).
