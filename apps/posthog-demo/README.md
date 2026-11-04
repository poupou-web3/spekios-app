# PostHog journey demo

A standalone fictional shop, **Fieldwork**, for recording a visit and turning it
into a Spekios browser workflow. When published, it is at
`https://demo-posthog.spekios.com` ([publishing the demo](./DEPLOY.md)).

This app is independent of the Spekios workspace: its own package/lockfile,
server, Docker image, Compose project and public PostHog ingestion token. It
cannot read product credentials, evidence or databases. PostHog is installed
only here; the Spekios interface is not instrumented.

## PostHog EU Cloud setup

The demo sends to its own PostHog EU Cloud project. Its local `.env` contains
only the public ingestion token and these nonsecret settings:

```dotenv
POSTHOG_DEMO_HOST=https://eu.i.posthog.com
POSTHOG_DEMO_UI_HOST=https://eu.posthog.com
POSTHOG_DEMO_TOOLBAR=true
POSTHOG_DEMO_PROJECT_TOKEN=<the demo project public phc_ token>
```

Copy `apps/posthog-demo/.env.example` to `apps/posthog-demo/.env` and fill in
the public token. Never use a personal `phx_` API key in this file or ship it
in the browser. The supplied toolbar authorization snippet's email, user ID and
session-specific parameters are not application configuration and are not saved
in source.

```sh
npm ci --prefix apps/posthog-demo
node --env-file=apps/posthog-demo/.env apps/posthog-demo/server.mjs
```

Open `http://localhost:18186` (`PORT` and `BIND` change the address). Alternatively, start the independent container:

```sh
docker compose --env-file apps/posthog-demo/.env -f apps/posthog-demo/compose.yaml up -d --build
```

That project is `spekios-posthog-demo-site`, with no product networks or volumes.
Its only exposed port is loopback 18186. Analytics and recording storage are managed by PostHog Cloud.

### Recording and toolbar

Open the demo and browse a product, pick a size, add it to your bag and place the fictional order. Event capture and session recording start automatically on page load; there are no start/finish controls. Page views, ordinary interaction autocapture and session snapshots are sent automatically. A page-hide beacon marks a visit complete when the visitor leaves; PostHog also settles inactive recordings. Fictional interactions also emit generic
`spekios_action` events based on stable selectors and `spekios_checkpoint`
observations. No workflow is hand-authored or sent directly to Spekios by the shop.
Input capture is masked; only the explicitly designated fictional size choice
is sent as an actionable value. Cross-subdomain cookies are disabled, and
anonymous session state stays in memory.

The loaded SDK is exposed as `window.posthog`. With `POSTHOG_DEMO_TOOLBAR=true`,
the demo serves the full SDK bundle with external-dependency support and allows
PostHog's domains in the **demo's** CSP; it does not enable inline scripts or eval.
With `false` (the container default), the no-external bundle and stricter CSP are used.
Controls expose both `data-testid` and matching `data-attr` attributes so the
PostHog action editor can use stable selectors.

Launch the toolbar from the EU PostHog dashboard while signed into the project
in the same browser. The URL must be authorized in PostHog **and** actually serve
the demo; authorize `http://localhost:18186` separately to use the toolbar locally.

### Connect Spekios to the recorded sessions

Follow [the connector setup](../../docs/platform/posthog.md). The private API
host is `https://eu.posthog.com`, distinct from the browser ingestion host
`https://eu.i.posthog.com`. The public `phc_` token only permits ingestion;
importing sessions needs the numeric project ID and a private personal API key
with `query:read` and `session_recording:read` access, entered in this Spekios website project's **Project settings → PostHog** form. Do not paste a toolbar authorization object into that form.

For local development, the recorded origin is `http://localhost:18186` and the
Docker worker's test origin is `http://host.docker.internal:18186`. Once the site
is published, connect from the Spekios project for `https://demo-posthog.spekios.com`; the project origin is fixed in its form.
Each connection filters one exact origin, keeping subdomain analytics separate.
The project must have session recording enabled to import full recordings.

Spekios's fresh validation browser marks itself `__SPEKIOS_REPLAY__`; this demo
then skips SDK initialization entirely to prevent an analytics feedback loop.

### Verification

```sh
npm test --prefix apps/posthog-demo
bash scripts/test-posthog.sh
```

These tests use disposable local fixtures and do not send Cloud traffic. The
explicit live check sends **one** anonymous visit to the configured Cloud
project, marked `spekios_setup_check=true`, `spekios_synthetic=true` and
`source_environment=local_preview`:

```sh
cd packages/browser-runtime
node --import tsx src/posthog-cloud-check.ts
```

Results are saved in ignored `artifacts/posthog/cloud-check.json`, without the
project token, email or any private key. The check confirms that recording
starts and that PostHog accepts the uploads; reading sessions back needs a
private read credential. `scripts/test-posthog.sh` also covers fresh-browser
replay and toolbar asset loading through a protocol fixture.

