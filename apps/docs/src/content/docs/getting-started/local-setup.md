---
{
  "title": "Run Scout locally",
  "description": "Start ScoutQA’s Rust API, Chromium worker, PostgreSQL, ClickHouse and private screenshot storage with Docker Compose.",
  "reviewed": "2026-10-31",
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

Nonsecret defaults can then be changed from the workspace **Settings** page without restarting.

## Allow a local or private target

Public https sites need no configuration. For a local, private or plain-http app, set **SCOUT_ALLOWED_ORIGINS** to its exact origin. The browser runs inside Docker, in the browser sandbox container; its localhost is that container, not your laptop. For a host app, use a Docker-reachable hostname such as **host.docker.internal** and configure that exact origin.

The built-in fixture uses **http://exploration-fixture:8082**. With just installed:

~~~sh
just fixture
~~~

This starts the target, but ordinary exploration still needs a configured model. The simulated-model test suites are separate.

## Check readiness and start

Use the operator back office at http://127.0.0.1:18083 or:

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
