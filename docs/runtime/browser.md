# Browser runtime

Browser work runs in TypeScript/Playwright (`packages/browser-runtime`), outside the Rust API's request lifecycle. How an exploration chooses and checks actions is described in [URL exploration](../exploration/overview.md) and [the planner](../exploration/planner.md); this page covers the processes, isolation and execution rules underneath. The evidence each action produces is described in [evidence](./evidence.md).

## Processes

| Service | Role | Holds credentials |
| --- | --- | --- |
| `browser-worker` (`src/worker.ts`) | Claims queued browser jobs from PostgreSQL, runs explorations, reproductions and fix verifications, calls the model gateway through the API, and writes evidence to the bucket, PostgreSQL and ClickHouse | Yes: database, bucket, ClickHouse, API token, saved sign-in vault (`auth-vault` volume) |
| `browser-sandbox` (`src/browser-server.ts`) | Runs Chromium only. The worker drives it remotely over Playwright's protocol at `ws://browser-sandbox:3000/browser` | No credentials, no volumes |
| `recorder` (profile `runtime`) | One-shot CLI for `just explore`, `just explore-matrix`, `just reproduce`, `just demo` and recovery commands | Same as the worker |
| `posthog-worker` | Imports PostHog sessions and replays flows in the same sandboxes ([PostHog](../platform/posthog.md)) | Database, bucket, vault key |

Compose starts `SCOUT_BROWSER_SLOTS` sandbox replicas (1–8, default 3). A run reserves a slot as a PostgreSQL advisory lock on its own connection, shared by every worker and CLI process, and waits without a deadline when all slots are busy. Each sandbox accepts exactly one client; when that client disconnects, Chromium closes and the container exits, and Docker restarts it fresh. Processes, cookies and `/tmp` from one run never reach the next.

## Isolation

- The sandbox is on the `browser` network only, with the test apps and the worker. PostgreSQL, the bucket, ClickHouse and the API are not reachable from it. It can reach the internet.
- Chromium's own sandbox stays on (`SCOUT_CHROMIUM_SANDBOX=true`). Containers run read-only, with no capabilities and `no-new-privileges`; the sandbox uses `infra/recorder/seccomp-chromium.json` (Docker's default profile plus the namespace calls Chromium needs).
- On the production host, containers cannot reach `169.254.0.0/16` (the cloud metadata service); each deploy checks this from inside `browser-sandbox` ([infra/deploy](../../infra/deploy/README.md)).
- Each run uses a new browser context with service workers blocked, downloads refused, popups closed, dialogs dismissed and locale `en-US`. Saved sign-in state is loaded only for runs that use it ([private login](../exploration/private-login.md)).
- A request gate (`installNetworkGate`) keeps top-level navigation on the entry page's registered domain. Subresources may load from the page's own origin and public HTTPS/WSS origins; a private page may also call the origins listed in `SCOUT_ALLOWED_ORIGINS`. Credential-bearing URLs are blocked.

This is container isolation on one shared host kernel, suitable for testing your own apps. It is not a virtual-machine or multi-tenant boundary for hostile sites.

## Viewports

| Profile | Size |
| --- | --- |
| `desktop` (default) | 1920 × 1080 |
| `tablet` | 768 × 1024 |
| `mobile` | 390 × 844 |

Profiles set viewport geometry at device scale 1 in Chromium; they do not emulate device user agents or touch, and mobile Chromium is not Mobile Safari. A reproduction uses the size its source run recorded. `SCOUT_EXPLORER_VIEWPORT` and the workspace settings choose the default.

## Execution rules

- Every dispatched action has a before and after screenshot and an assessment, or an explicit evidence gap. Missing evidence stops that run from advancing; a later replay never fills an earlier action's gap.
- After each action the runtime samples the page until it is quiet (up to 24 frames, 200 ms apart, within five seconds) and records the settling frames ([action outcomes](../exploration/action-outcomes.md)).
- A failed automation step is not a product bug. Access blocks, infrastructure failures, uncertain expectations and suspected product failures are recorded separately.
- A suspected issue is confirmed only through a separate reproduction in a fresh browser and a human review ([reproduction](../exploration/reproduction.md), [finding reviews](../exploration/finding-reviews.md)).
- Model output is a proposal: it cannot widen the network scope, spend a budget, unlock a credential or mark a finding confirmed.
- Form writes are refused unless `SCOUT_TEST_FORM_RULES` permits them for a disposable test app.
- If the worker dies, recovery keeps the evidence and never repeats an action that may have been dispatched; the job becomes interrupted ([cancellation](../exploration/cancellation.md)).
- Video recording is off. Replay uses the ordered screenshots, actions, predictions and masks.

## Not built yet

- A scoped worker API, so the worker stops writing to PostgreSQL, the bucket and ClickHouse directly.
- Per-tenant isolation strong enough for untrusted multi-tenant hosting: a VM-level sandbox per run, and an egress proxy that rejects private, link-local and metadata addresses through redirects, DNS rebinding and alternative transports.
- Live push of run events (the workspace polls).
- Firefox and WebKit engines, and device emulation beyond viewport size.
- Account leasing and data reset contracts for stateful journeys, so reproductions start from known server-side data.
