---
{
  "title": "Run Spekios locally",
  "description": "Start Spekios’s Rust API, Chromium worker, PostgreSQL, ClickHouse and private screenshot storage with Docker Compose.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 1
  }
}
---
Run the local stack from a checkout of the Spekios repository. The stack includes the web workspace, operator back office, API, browser worker, browser sandbox and storage. You do not need a hosted documentation or QA account.

## Prerequisites

- Docker Engine with the Compose plugin, or Docker Desktop, running on your machine.
- Node.js to run the repository’s setup scripts. Node 24 is required if you also build these docs.
- A terminal opened at the repository root.
- For live exploration, one supported model-provider API key.

The optional **just** command runner provides shortcuts. Building the native MCP bridge additionally requires the repository’s Rust toolchain.

## Start the services

~~~sh
bash scripts/start-local.sh
~~~

The setup creates independent random local credentials if they do not exist, preserves an existing configuration and starts the Compose services. The private configuration file is **.env**; never commit it. With just installed, `just up` runs the same script.

Open [the local workspace](http://127.0.0.1:18080). In normal token mode, sign in using **SCOUT_API_TOKEN** from your local configuration. A deliberately enabled loopback development bypass can hide this screen; it does not remove MCP authentication.

## Connect a model

Add an API key under **Settings → Models → Your API keys** and choose an exploration model; see [model configuration](../models/). Setup generates the vault key that encrypts saved keys. Operator environment keys in **.env** also work for local use; restart the services after changing environment-level settings:

~~~sh
bash scripts/start-local.sh
~~~

Nonsecret defaults can then be changed from the workspace **Settings** page without restarting.

## Test a local or private app

Any http or https address can be tested; no allowlist entry is needed for the URL you paste. The browser runs inside Docker, in the browser sandbox container, so its localhost is that container, not your computer. Spekios opens a loopback address such as `http://localhost:3000` as `http://host.docker.internal:3000`. Docker Desktop provides that hostname; on other Docker hosts, make sure it resolves and that your app listens on an interface the container can reach.

**SCOUT_ALLOWED_ORIGINS** is only for other private origins that a local or private page loads resources from, such as a separate local API. A public https page never gets that list.

The built-in fixture uses **http://exploration-fixture:8082**. With just installed:

~~~sh
just fixture
~~~

This starts the target, but ordinary exploration still needs a configured model. The simulated-model test suites are separate. `just bug-lab` starts Larchwood, a small shop with known bugs, at **http://larchwood:8084** (bugs on) and **http://larchwood:8085** (every bug fixed).

## Check readiness and start

Use the operator back office at http://127.0.0.1:18083 (sign in with **SCOUT_API_TOKEN**) or:

~~~sh
docker compose ps
just models
~~~

Provider availability is distinct from API health. Then [submit your first URL](../first-run/).

## Deploy this stack on a host

Docker is enough. From the repository root:

~~~sh
just deploy
~~~

This starts the workspace, operator console, API, browser workers, PostgreSQL, ClickHouse and the evidence bucket, then applies the database schemas. The workspace stays on loopback until **SCOUT_PUBLISH** is set to a host address such as `0.0.0.0` (plain HTTP). For a public HTTPS name, set **SCOUT_PUBLIC_HOST** and **SCOUT_PUBLIC_ORIGIN** in `.env` and run `just deploy edge`. That proxy listens on ports 80 and 443. The direct workspace port and the operator console stay on this machine.

Stopping containers preserves volumes. Do not delete volumes to fix an ordinary startup problem; they contain recordings, database history and saved sessions. See [troubleshooting](../../operators/troubleshooting/).
