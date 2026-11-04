# PostHog journeys connector

Spekios imports event analytics and recorded sessions from PostHog Cloud and turns recorded journeys into flows it can replay in a test browser. Each connection belongs to one Spekios website project, workspace **and** user. A website project is identified by its exact origin, which is separate from the numeric PostHog project ID. A different test origin can be given for replays. A shared parent domain never grants access to another subdomain's data.

The importer is the `posthog-worker` service (`packages/browser-runtime/src/posthog-worker.ts`), started by `just dev` and `just deploy`. It runs no PostHog server and stores no recordings outside PostgreSQL. The [demo shop](../../apps/posthog-demo/README.md) is a separate app with its own PostHog project; the product does not depend on it, and the Spekios interface itself is not instrumented.

## Configuration

Personal PostHog API keys are encrypted with AES-256-GCM using `SCOUT_PROVIDER_VAULT_KEY` (64 hex characters, created by the setup scripts) and bound to the connection and owner. Keep the existing vault key; replacing it makes saved credentials unreadable.

```dotenv
# Allowed server-side API origins (exact, comma-separated). Default: EU and US Cloud.
SCOUT_POSTHOG_HOSTS=https://eu.posthog.com,https://us.posthog.com
# Test origins that replays may run against. Default: none.
SCOUT_POSTHOG_REPLAY_ORIGINS=https://demo-posthog.spekios.com
```

Connections to origins outside `SCOUT_POSTHOG_REPLAY_ORIGINS` still import and show inferred flows but cannot replay them. Redirects and credential-bearing URLs are rejected. Only list resettable test environments; never a real checkout or payment system. For a host-only local demo, configure a test origin the Docker browser can reach, such as `http://host.docker.internal:18186`.

## Connect a website

Open **Projects → the website → Project settings → PostHog** and choose **Connect PostHog**. Enter the region, the PostHog project ID (or dashboard URL), an optional test origin, and a personal API key with only the `query:read` and `session_recording:read` scopes, restricted to that PostHog project ([PostHog key settings](https://eu.posthog.com/settings/user-api-keys)). **Verify and connect** checks both read APIs before encrypting and saving the key. The key is never returned by the API, stored in the browser or included in error messages.

The private API host is `https://eu.posthog.com` (or `us`); browser capture uses `https://eu.i.posthog.com`. A public `phc_` project token or a toolbar authorization snippet cannot import sessions.

- **Automatically validate new completed journeys** queues one background replay per distinct executable flow. Otherwise replays start from each flow's **Replay in test browser** button.
- **Pause** stops new imports and interrupts a replay before its next step.
- **Disconnect** deletes the credential, analysis, imported sessions, flows and replay results.

The server scopes every list, read, change and replay to the project's origin. Connect each subdomain from its own project.

## Analysis

Each connection shows events, unique visitors (`distinct_id`), unique session IDs, page views, exceptions, rage clicks and dead clicks, plus daily counts, top events and top page paths for the current UTC day and the six days before it. Every query filters the exact source origin and excludes events with `spekios_synthetic=true`. Four aggregate queries refresh every five minutes, independently of session import; a failure retries after a minute and keeps the last snapshot with its timestamp. **Sync now** refreshes both. The settings page lists the latest 30 flows and sessions and 20 replays.

## Import and replay

- The first scan covers seven days; later scans overlap 24 hours to catch late events. Scan windows and pagination cursors survive restarts. Imports poll every minute, and a session must be quiet for a minute before automatic replay.
- Requests stay on the allowed API origin. Responses are capped at 8 MiB, session events at 500 and snapshots at 30,000; exceeding a cap is reported, not treated as a complete recording.
- Snapshots are read through PostHog's blob API (JSONL, window envelopes, gzip/zstd fields). Structured `spekios_action`/`spekios_checkpoint` events, as sent by the demo shop, can produce complete flows without snapshots.
- Steps resolve to stable `id` or `data-testid` selectors. Unsupported selectors, masked or sensitive inputs, multi-tab recordings, missing initial state and cross-origin, query or fragment navigation are reported as gaps.
- Equivalent flows share a versioned fingerprint. A replay uses a frozen copy of the steps, a fresh isolated browser (sharing the ordinary browser slots) and a two-minute deadline, and never restores a real user's cookies. It allows only the test origin and blocks service workers, other destinations and popups. The replay browser sets `__SPEKIOS_REPLAY__`; sites with a same-origin analytics proxy should honor it or mark the session synthetic.
- One worker holds a database advisory lock. Pending work is durable; running work becomes interrupted after a crash and is never re-dispatched automatically.
- `matched_observations` means recorded visible observations matched the test deployment; `steps_executed` means the steps ran without a recorded outcome. Neither proves the product meets its requirements.

## API

`{origin}` is the URL-encoded website origin, for example `https%3A%2F%2Fdemo-posthog.spekios.com`; create requests must send the matching `source_origin`. Every endpoint requires a signed-in workspace manager. Agent credentials cannot reach connector credentials or imported journeys.

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/v1/websites/{origin}/posthog/connections` | List or create your connections |
| GET | `/v1/websites/{origin}/posthog/connections/{id}` | Analysis, flows, sessions and replays |
| POST | `/v1/websites/{origin}/posthog/connections/{id}/sync` | Resume and request an import |
| POST | `/v1/websites/{origin}/posthog/connections/{id}/pause` | Pause imports and replay steps |
| POST | `/v1/websites/{origin}/posthog/connections/{id}/remove` | Delete the credential and imported data |
| POST | `/v1/websites/{origin}/posthog/connections/{id}/workflows/{workflow_id}/replay` | Queue a replay on the allowed test origin |

## Tests

```sh
just posthog-test        # disposable database, protocol fixture, real SDK and Chromium
just posthog-edge-test   # HTTPS/AOP fixture for the published demo
```

References: [PostHog API](https://posthog.com/docs/api), [recording snapshots](https://posthog.com/docs/session-replay/snapshot-api), [HogQL queries](https://posthog.com/docs/api/queries).
