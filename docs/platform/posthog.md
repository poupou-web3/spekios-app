# PostHog journeys connector

Spekios imports event analytics and recorded journeys from PostHog Cloud. Each connection belongs to one Spekios website project, workspace **and** user. A website project is identified by its exact origin; this is separate from the numeric PostHog project ID. The website is fixed by the selected project. A different test origin can be supplied for
execution. A shared parent domain never grants access to another subdomain's data.

The independent [demo website](../../apps/posthog-demo/README.md) uses its own PostHog EU Cloud project and public capture token. The product has no dependency on that app or its token. The self-hosted installation, capacity monitor and dedicated Docker data have been removed. The Spekios interface is not instrumented; the independent demo is published only when explicitly enabled in deployment settings.

## Cloudflare DNS for the demo

For the existing Hetzner origin used by `app.spekios.com`, open Cloudflare →
`spekios.com` → DNS → Records → Add record:

| Field | Value |
| --- | --- |
| Type | `A` |
| Name | `demo-posthog` |
| IPv4 address | Copy the origin IP from the **Content** of the existing `app` A record |
| Proxy status | Proxied (orange cloud) |
| TTL | Auto |

Save the record. Use the address stored in Cloudflare's dashboard, rather than
the proxy IP returned by a public DNS lookup. This hostname serves the separate
demo website; it does not point at the PostHog Cloud ingestion or dashboard host.
See [Cloudflare's subdomain guide](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-subdomain/).

DNS alone does not publish the site. The checked-in public edge currently has
routes and certificates for the app, operator console and Larchwood demos, and
still needs the prepared [demo edge overlay and route](../../apps/posthog-demo/DEPLOY.md) deployed, plus an origin
certificate covering `demo-posthog.spekios.com`. Apply Full (strict) TLS to this
hostname while retaining the existing authenticated origin pulls. The demo
container must keep its own Compose project and stay off product storage
networks. The normal main-based release can enable the separate demo through its deployment settings. See [Cloudflare Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/).

## Local product setup

The connector uses the existing credential vault key,
`SCOUT_PROVIDER_VAULT_KEY` (64 hexadecimal characters). Keep an existing key;
replacing it makes previously saved credentials unreadable. Personal PostHog API
keys are encrypted with AES-256-GCM and bound to the connection and owner.

EU and US Cloud API hosts are allowed by default. In the **product** environment, optionally restrict the region and allow browser execution on the separate test website:

```dotenv
SCOUT_POSTHOG_HOSTS=https://eu.posthog.com
SCOUT_POSTHOG_REPLAY_ORIGINS=https://demo-posthog.spekios.com
```

`SCOUT_POSTHOG_HOSTS` is an exact comma-separated allowlist of server-side API
origins. `SCOUT_POSTHOG_REPLAY_ORIGINS` authorizes resettable test environments
for browser execution. Connections to other sources can still import and show
inferred flows, but cannot execute them. Redirects and credential-bearing URLs
are rejected. Do not allow a real checkout/payment system as a resettable demo.

Apply the additive `infra/postgres/031-posthog.sql` to the local product database
using the normal schema workflow, then start the API and lightweight Cloud importer:

```sh
bash scripts/apply-schemas.sh
docker compose up -d --build api posthog-worker
```

These are **local development** commands. Production changes must first merge into `origin/main` and use the normal release playbook.

Open **Projects → select the website → Project settings → PostHog**, choose **Connect PostHog**, and enter the
region, PostHog project ID (or dashboard URL), optional test origin and a private personal
API key with `query:read` and `session_recording:read` scopes for that project.
The project website is prefilled and read-only. Personal keys are created in [PostHog account settings](https://eu.posthog.com/settings/user-api-keys); restrict Organization & project access to this one PostHog project and select only the two read scopes. The form links to the selected region’s key page. Choose **Verify and connect**. Spekios checks both read APIs before encrypting and saving the key. The private key is never returned by the API, stored in browser storage, or included in an import error. The Cloud private API host is `https://eu.posthog.com`; browser capture uses
`https://eu.i.posthog.com`. A public `phc_` project token or toolbar authorization
snippet cannot authenticate session-import requests. The demo site's public ingestion token is a different credential.

Check **Automatically validate new completed journeys** to queue one background
validation per distinct executable flow. Imports otherwise run automatically but
browser validation starts from each flow's **Replay in test browser** button.
Pause stops new imports and interrupts a replay before its next step.
Disconnect deletes the credential, analysis, imported sessions, flows and replay results. Connect each website from its own project settings to analyze multiple subdomains separately. Setup and analysis are absent from global workspace settings. Lists, reads, changes and replay admission are all constrained by the project origin on the server; changing the URL cannot access another project’s connection. In-flight browser responses are discarded when the user switches projects. The demo remains a separate project.

The connector worker is included in `compose.yaml` and the regular deployment script. It has a 384 MiB memory ceiling and shares existing isolated browser slots; no PostHog server, ClickHouse instance or recording storage is added. The interface reports when its background worker is offline. Updating the deployment configuration does not deploy this branch. For Docker replays against a host-only demo, explicitly configure a reachable test origin and its host/network mapping in a local override; the production default enables no replay origins.

## Analysis in Spekios

Each connection shows events, unique visitors (`distinct_id`), unique nonempty session IDs, page views, exceptions, rage clicks and dead clicks. Daily event counts, top events and top page paths cover the current UTC day plus the preceding six days. Every query filters the exact source origin and excludes events with `spekios_synthetic=true`; sibling subdomains are excluded. Visitor identity and click/error coverage depend on the tracking configured in the source site.

Four bounded aggregate queries refresh every five minutes independently of recording import. Analytics therefore works even with no recordings available. Failures retry after a minute and retain the last successful snapshot with its timestamp and a visible error. Sync now requests both analytics and session refresh. This view contains aggregated metrics and inferred workflows, rather than an embedded PostHog dashboard.

## Import and execution contract

- The first scan covers seven days. Fixed scan windows, cursor/offset pagination
  and session upserts survive restarts; later scans overlap 24 hours to catch
  late ingestion. Imports poll every minute and wait a minute for final events
  to settle before automatic execution.
- Session/query/snapshot requests remain on the allowed API origin. Responses
  and combined snapshot text are bounded to 8 MiB, decoded snapshot fields to
  16 MiB per blob, session events to 500 and snapshots to 30,000. Exceeding a
  bound is surfaced, not treated as a successful complete recording.
- Raw snapshots use PostHog's internal blob_v2 API with explicit blob ranges.
  Supported encodings include JSONL, window envelopes and SDK gzip/zstd fields.
  API/format failures remain visible per session. Structured demo interaction
  events can still produce complete flows without raw snapshots; analytics-only
  partial journeys remain blocked.
- Generic web extraction resolves stable IDs/test IDs through recorded DOM
  snapshots and mutations. Unsupported selectors, masked/sensitive inputs,
  multi-tab recordings, unsupported interactions, missing initial state and
  cross-origin/query/fragment navigation remain explicit gaps.
- Equivalent normalized steps are grouped by a versioned fingerprint. Labels do
  not affect identity. Execution uses a frozen copy of at most 40 steps, a fresh
  isolated browser and a two-minute deadline. It does not restore a real user's
  cookies or credentials. Authenticated flows need separate test-account support.
- Replays permit only the test origin, block other network destinations,
  service workers, WebSockets and popups, and share the ordinary sandbox slot
  locks. The controlled demo has no payments or external mutations. Applications
  using a same-origin analytics proxy should also honor `__SPEKIOS_REPLAY__` or
  mark synthetic sessions so they are excluded from subsequent discovery.
- A single worker holds a database advisory lock. Pending work is durable;
  running work becomes interrupted after a worker crash. Uncertain interactions
  are never automatically re-dispatched. A failed automatic attempt stays visible.
- `matched_observations` means recorded visible observations matched the test
  deployment. `steps_executed` means the steps ran without an explicit recorded
  outcome. Neither establishes correctness against product requirements.

The settings page shows the latest 30 flows/sessions and 20 validations, plus
overall imported counts and per-origin event analysis. This is a first connector, not a general conversion of
every arbitrary recording into a guaranteed reproducible regression test.

## API

In API paths, `{origin}` is the URL-encoded website origin, for example `https%3A%2F%2Fdemo-posthog.spekios.com`. Create bodies must supply the matching `source_origin`. The former global connector paths are not exposed.

All endpoints require an authenticated workspace manager; agent credentials do
not grant access to connector credentials or imported journeys.

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/v1/websites/{origin}/posthog/connections` | List or create owned connections |
| GET | `/v1/websites/{origin}/posthog/connections/{id}` | Analysis, flows, sessions and validations |
| POST | `/v1/websites/{origin}/posthog/connections/{id}/sync` | Resume/request background import |
| POST | `/v1/websites/{origin}/posthog/connections/{id}/pause` | Pause importing and subsequent replay steps |
| POST | `/v1/websites/{origin}/posthog/connections/{id}/remove` | Delete credential and imported data |
| POST | `/v1/websites/{origin}/posthog/connections/{id}/workflows/{workflow_id}/replay` | Queue an allowlisted test execution |

Source references: [PostHog APIs](https://posthog.com/docs/api),
[recording snapshots](https://posthog.com/docs/session-replay/snapshot-api),
[HogQL queries](https://posthog.com/docs/api/queries), and [supported aggregations](https://posthog.com/docs/sql/aggregations).
