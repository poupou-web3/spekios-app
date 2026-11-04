# PostHog journey demo

A standalone fictional shop, **Fieldwork**, for recording a visit and turning it
into a Spekios browser workflow. Public hostname:
`demo-posthog.spekios.com`. The HTTPS route is enabled by the optional production deployment configuration. See [deployment instructions](./DEPLOY.md).

This app is independent of the Spekios workspace: its own package/lockfile,
server, Docker image, Compose project and public PostHog ingestion token. It
cannot read product credentials, evidence or databases. Monitoring is installed
only here; the actual Spekios interface is not instrumented by this change.

## PostHog EU Cloud setup

The demo now uses the dedicated PostHog Cloud project. Its private local `.env`
contains only the public ingestion token and these nonsecret settings:

```dotenv
POSTHOG_DEMO_HOST=https://eu.i.posthog.com
POSTHOG_DEMO_UI_HOST=https://eu.posthog.com
POSTHOG_DEMO_TOOLBAR=true
POSTHOG_DEMO_PROJECT_TOKEN=<the demo project public phc_ token>
```

For a fresh checkout, copy `.env.example` to `apps/posthog-demo/.env`, then fill
in the public token. Never use a personal `phx_` API key in this file or ship it
in the browser. The supplied toolbar authorization snippet's email, user ID and
session-specific parameters are not application configuration and are not saved
in source.

```sh
npm ci --prefix apps/posthog-demo
node --env-file=apps/posthog-demo/.env apps/posthog-demo/server.mjs
```

Open `http://localhost:18186`. Alternatively, start the independent container:

```sh
docker compose --env-file apps/posthog-demo/.env -f apps/posthog-demo/compose.yaml up -d --build
```

That project is `spekios-posthog-demo-site`, with no product networks or volumes.
Its only exposed port is loopback 18186. Analytics and recording storage are managed by PostHog Cloud.

### Recording and toolbar

Choose **Start recorded visit**, browse a product, pick a size, add it to your
bag, place the fictional order, and choose **Finish visit**. Recording and event
capture are opt-in for each visit, including ordinary interaction autocapture
when toolbar support is enabled. Fictional interactions also emit generic
`spekios_action` events based on stable selectors and `spekios_checkpoint`
observations. No workflow is hand-authored or sent directly to Spekios by the shop.
Input capture is masked; only the explicitly designated fictional size choice
is sent as an actionable value. Cross-subdomain cookies are disabled, and
anonymous session state stays in memory.

The loaded SDK is exposed as `window.posthog`. Toolbar-enabled mode serves the
full SDK bundle with external-dependency support and allows PostHog's domains
for its scripts, API calls, styles, fonts, images and media in the **demo's** CSP.
It does not enable inline scripts/eval or change the actual workspace CSP. With
`POSTHOG_DEMO_TOOLBAR=false`, the no-external bundle and stricter CSP are used.
Controls expose both `data-testid` and matching `data-attr` attributes so the
PostHog action editor can use stable selectors.

Launch the toolbar from the EU PostHog dashboard while signed into the project
in the same browser. The URL must be authorized in PostHog **and** actually serve
the demo. `https://demo-posthog.spekios.com` points at the origin and requires the separate demo route and TLS certificate described in the deployment guide. PostHog URL authorization does not install either.
Production must use a release from `origin/main`. Authorize localhost
separately in PostHog if the toolbar is needed before publishing the demo.

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
project token, email or any private key. The setup check observed recording
start and HTTP 200 for both event and recording uploads. API acceptance is not
proof of retained/queryable data; reading back sessions still needs a private
read credential. The full local tests also verify fresh-browser reproduction
and toolbar asset loading through a protocol fixture.

