---
{
  "title": "Run Scout locally",
  "description": "Start ScoutQA’s Rust API, Chromium worker, PostgreSQL, ClickHouse and private screenshot storage with Docker Compose.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 1
  }
}
---
Run the local stack from a checkout of the Scout repository. The stack includes the web workspace, API, browser worker and storage. You do not need a hosted documentation or QA account.

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

The setup creates independent random local credentials if they do not exist, preserves an existing configuration and starts the Compose services. The private configuration file is **.env**; never commit it.

Open [the local workspace](http://127.0.0.1:18080). In normal token mode, sign in using **SCOUT_API_TOKEN** from your local configuration. A deliberately enabled loopback development bypass can hide this screen; it does not remove MCP authentication.

## Connect a model

Add one provider key to the private configuration and choose an exploration model. Follow [model configuration](../models/). Restart the services after changing environment-level settings:

~~~sh
bash scripts/start-local.sh
~~~

Nonsecret defaults can then be changed from **Back office → Connections** without restarting.

## Permit a controlled target

Set **SCOUT_ALLOWED_ORIGINS** to the exact origin of an app you control. The browser worker runs inside Docker; its localhost is the container, not your laptop. For a host app, use a Docker-reachable hostname and configure that exact origin.

The built-in fixture uses **http://exploration-fixture:8082**. With just installed:

~~~sh
just fixture
~~~

This starts the target, but ordinary exploration still needs a configured model. The simulated-model test suites are separate.

## Check readiness and start

Use **Back office → Operations** or:

~~~sh
docker compose ps
just models
~~~

Provider availability is distinct from API health. Then [submit your first URL](../first-run/).

Stopping containers preserves volumes. Do not delete volumes to fix an ordinary startup problem; they contain recordings, database history and saved sessions. See [troubleshooting](../../operators/troubleshooting/).
