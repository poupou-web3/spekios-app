---
{
  "title": "Capabilities and current limits",
  "description": "Check what Spekios implements today, including browser actions, model providers, reports, sign-in, replay and deployment limitations.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 5
  }
}
---
Spekios is a self-hosted developer preview. This page distinguishes implemented behavior from work that still needs to be built or validated.

## Implemented

| Area | Available now |
| --- | --- |
| Input | URL-only exploration of any http or https address the browser sandbox can reach, including local and private apps. Loopback addresses such as `localhost` open as `host.docker.internal`. |
| Browser | Chromium with desktop, tablet and mobile viewport profiles. |
| Actions | Native navigation, click, text/search fill, single-select, checkbox/radio, document scroll and permitted form submission. Conditional direct-Meta computer-use recovery adds visual clicks, hover, panel scroll and explicit drag gestures; [capability checks and opt-outs](../../getting-started/models/#computer-use-recovery) apply. |
| Planning | Likely-action ranking, recorded graph/frontier, duplicate avoidance, branch returns, stale-state replanning, controls further down the page, versioned active-run testing focus and [memory across runs](../../guides/app-memory/) with reopening of unfinished pages. An [app map](../../guides/app-memory/#the-app-map) of states and transitions carried between runs and compared run to run. Each run [shares its actions](../../guides/exploration-strategy/) between new territory, deep journeys and re-walks of the map, with depth and coverage reported per level. [Fewer model calls](../../guides/exploration-cost/): unchanged screens reuse earlier rankings, and an optional cheaper model handles navigation. No action, time, token or cost limit unless a user [sets one](../../guides/exploration-limits/). |
| Checks | Pre-action expectations, per-action assessments, exact image differences, sampled completion frames and redacted diagnostics. |
| Findings | Original suspicions, fresh-browser replay, optional bounded automatic replay and append-only human review. |
| Triage | Bug, intended behavior, duplicate or needs review, decided by people, agents or Spekios; later runs recognize known behavior by page, control, viewport and sign-in state. See [triage and rechecks](../../guides/triage/). |
| Rechecks | Verify a deployment against every open issue of a site (up to 25), from the workspace, an agent or CI with exit codes. |
| Agent identity | User setup page, standard MCP browser OAuth with PKCE/DCR and rotating renewal, native connector compatibility, private history, revocation and token attribution. |
| Access | Human-controlled native same-origin sign-in, optional test-account creation on supported signup forms and optional encrypted session reuse for 24 hours. |
| Models | OpenAI, Anthropic, OpenRouter and Meta AI API-key connections; nullable token/cost accounting. |
| Interfaces | User workspace, separate operator back office, REST API, [MCP/HTTP agent tools](../../agents/tools/), a CLI and a Rust stdio bridge. |
| Analytics import | Optional PostHog Cloud connection per website project, under its **Project settings**: imports events and recorded journeys. Browser validation of imported journeys runs only on origins the operator lists in `SCOUT_POSTHOG_REPLAY_ORIGINS`. |
| Exports | JSON snapshot, Markdown report and verified evidence ZIP. |

## Not implemented yet

- Native mobile apps, Firefox or WebKit coverage.
- Arbitrary JavaScript, general custom input/contenteditable support, file uploads, downloads or iframe interaction. Visual recovery can operate some custom menus and draggable controls; it does not authorize arbitrary interactions.
- Checkout, unapproved form submissions or account creation beyond the [supported signup flow](../../getting-started/private-apps/#let-spekios-create-a-test-account).
- Google/external OAuth handoff, passkeys or reuse of an ordinary desktop browser’s cookies.
- Subscription login that spends ChatGPT, Claude or coding-agent usage allowances.
- An external observe/act/assess API.
- Source-repository integration, automatic code fixes or source-location inference.
- Team invitations, subscription billing and public community sharing. Optional human sign-in through the hosted Spekios login is configured by the operator (`SPEKIOS_*` settings).
- Kubernetes manifests or automatic continuation after a worker restart. Interrupted jobs stay interrupted; choose **Continue exploration** or **Run again** to start more work. A dispatched action is never repeated during recovery.
- Full tool input/output payload auditing, approved training export or continuous video capture. Route/tool metadata audit is implemented.
- A built-in recheck scheduler, workspace spend budgets, hand-written test cases or a chat-style session view. Run [scripts/scout-recheck.mjs](../../guides/triage/#recheck-after-a-deploy) from CI or cron for scheduled rechecks.

## Permanent issue and candidate history

Completed reliable suspicions receive stable issue IDs. Users and agents share a frozen expected/actual handoff, original reproduction path and screenshots. Candidate URL submission queues a fresh-browser verification, preserving both evidence sets and per-run usage. Outcomes are resolved on candidate, still reproducible, blocked or inconclusive. Cancellation, interruption, missing evidence and changed preconditions never count as resolved. See [fix verification](../../guides/fix-verification/).

## Verification boundary

Automated integration uses real Chromium and local storage with simulated model providers. That validates contracts, evidence handling and recovery. Live-model exploration quality and correctness on arbitrary real apps remain separate validation work. Browser OAuth is integration-tested locally; individual vendor apps and external HTTPS deployments still need interoperability validation.

Target pages run in a separate browser sandbox container that holds no Spekios credentials or saved logins and cannot reach Spekios's database, evidence store, analytics, API or model gateway. Chromium's own sandbox is on, and the container restarts after every run. See [access and recording boundaries](../../operators/security/) for what the sandbox can still reach.

Explorations act like a user and can change data on the site. Prefer a test account on apps with real data.

For setup problems, use [troubleshooting](../../operators/troubleshooting/).
