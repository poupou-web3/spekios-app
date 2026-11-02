set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments

# Show available development commands.
default:
    @"{{just_executable()}}" --list

# Public docs have their own static build and independent Compose service.
docs-install:
    npm ci --prefix apps/docs --no-audit --no-fund

docs-dev:
    npm run dev --prefix apps/docs

docs-build:
    npm run build --prefix apps/docs

docs-test:
    npm run check --prefix apps/docs
    npm test --prefix apps/docs
    node apps/docs/scripts/check-api-contract.mjs

# Export pure schemas; no API, database or model calls.
docs-sync-api:
    node apps/docs/scripts/sync-api.mjs

docs-up:
    docker compose -f compose.docs.yaml up -d --build --wait

docs-down:
    docker compose -f compose.docs.yaml down

# Copy lightweight instructions only; MCP/service setup remains explicit.
skill-install client="codex":
    python3 scripts/install-scout-skill.py --client "$1"

skill-test:
    python3 -m unittest discover -s scripts -p 'test_scout_skill.py'

# Start the API and storage services, preserving existing data and credentials.
up:
    bash scripts/start-local.sh

dev: up

# Deploy the workspace, operator console, API, workers, Postgres, ClickHouse and evidence storage.
# `just deploy edge` also publishes HTTPS for SCOUT_PUBLIC_HOST.
deploy mode="":
    bash scripts/deploy.sh {{mode}}

# Hetzner + Cloudflare production host (infra/deploy/README.md).
# Needs HCLOUD_TOKEN and CLOUDFLARE_API_TOKEN in the environment.
# Read-only: confirms both tokens have every permission cloud-apply needs.
cloud-check:
    bash infra/deploy/check-access.sh

cloud-plan:
    "$(command -v tofu || command -v terraform)" -chdir=infra/deploy/terraform plan

cloud-apply:
    "$(command -v tofu || command -v terraform)" -chdir=infra/deploy/terraform apply

# Configure the host and ship origin/prod as it is on GitHub. Extra args go to
# ansible-playbook, e.g. `just cloud-deploy --tags app`, or roll back with
# `just cloud-deploy --tags app -e scout_ref=<older sha on prod>`.
cloud-deploy *args:
    cd infra/deploy/ansible && ansible-playbook site.yml "$@"

# Stop that deployment, including the HTTPS proxy, and keep the database volumes.
deploy-stop:
    COMPOSE_FILE=compose.yaml:compose.deploy.yaml docker compose --profile edge stop

# Recreate the API so it loads the current .env. Does not rebuild the image.
reload-env:
    docker compose up -d --no-deps --force-recreate --wait api

# Rebuild the workspace and back office after a UI change. Databases and workers stay up.
reload:
    docker compose up -d --build --wait --wait-timeout 120 api backoffice
    @echo "Scout workspace: http://127.0.0.1:18080"
    @echo "Scout back office (operators): http://127.0.0.1:18083"

# Rebuild only the workspace API. It embeds apps/web, including the favicon.
reload-api:
    docker compose up -d --build --wait --wait-timeout 120 api
    @echo "Scout workspace: http://127.0.0.1:18080"

# Rebuild only the operator console. Does not rebuild the API.
reload-backoffice:
    docker compose up -d --build --no-deps --wait --wait-timeout 60 backoffice
    @echo "Scout back office (operators): http://127.0.0.1:18083"

# Start the local workspace and print its URL.
ui: up
    @echo "Scout workspace: http://127.0.0.1:18080"
    @echo "Scout back office (operators): http://127.0.0.1:18083"

# The operator console runs in its own container, separate from the customer workspace.
backoffice: up
    @echo "Scout back office (operators): http://127.0.0.1:18083"

# Real GUI API/worker integration with simulated models; restores normal mode.
workspace-test:
    bash scripts/test-workspace.sh

# Delayed form journeys, completion, diagnostics and exact replay.
outcomes-test:
    bash scripts/test-explorer.sh test/outcomes.test.ts

web-test:
    node --test apps/web/test/*.test.mjs packages/web-ui/test/*.test.mjs apps/backoffice/test/*.test.mjs

# Durable editable defaults, admission snapshots and retries without inference.
settings-test:
    bash scripts/test-exploration-settings.sh

# Download a frozen selected-run report and verified evidence without inference.
export-report run_id:
    node scripts/export-run-report.mjs "$1"

# Read-only stored-run exports checked by an independent standard ZIP reader.
report-export-test:
    node scripts/verify-report-export.mjs

# Render stored run snapshots through the UI templates without browser automation.
web-contract-test:
    node scripts/verify-ui-rendering.mjs
    node scripts/verify-gui-contract.mjs

jobs:
    node scripts/api-read.mjs /v1/browser-jobs

operations:
    node scripts/api-read.mjs /v1/operations

# Show service health and local ports.
status:
    docker compose ps

# Stop services while preserving the evidence volumes.
stop:
    docker compose stop

logs:
    docker compose logs --tail=100 api

build-recorder:
    docker compose build recorder

# Run three real-browser fixture flows and print their evidence IDs.
demo: build-recorder
    docker compose run --rm --no-deps recorder demo

# Read the newest recorded runs through the Rust API, without printing the token.
runs:
    node scripts/api-read.mjs /v1/runs

run run_id:
    node scripts/api-read.mjs "/v1/runs/$1"

recover run_id:
    docker compose run --rm --no-deps recorder recover "$1"

flush:
    docker compose run --rm --no-deps recorder flush

api-check:
    cargo check --locked --manifest-path apps/api/Cargo.toml

api-test:
    cargo test --locked --manifest-path apps/api/Cargo.toml --lib --bins

# Build the native stdio bridge used by local MCP clients.
mcp-build:
    cargo build --locked --release --manifest-path apps/api/Cargo.toml --bin scout-mcp

# Start only the stdio bridge; the ordinary local API must already be running.
mcp:
    @apps/api/target/release/scout-mcp --env-file "$PWD/.env"

# Print an MCP client configuration with absolute paths and no embedded token.
mcp-config:
    @node scripts/mcp-config.mjs

# HTTP/stdio agent workflow with real browser/storage and simulated models.
agent-test:
    bash scripts/test-agent-interface.sh

# Inspect provider configuration without revealing credentials.
models:
    node scripts/api-read.mjs /v1/model-providers

usage:
    node scripts/api-read.mjs /v1/usage

# Submit a JSON call; the file's request_id makes repeated submissions idempotent.
model-call file:
    node scripts/model-call.mjs "$1"

model-request request_id:
    node scripts/api-read.mjs "/v1/model-requests/$1"

# Fake providers only; briefly restarts API/S3/ClickHouse, then restores normal mode.
model-test:
    bash scripts/test-model-gateway.sh

# URL-only entry point; model and trusted-app origins come from local configuration.
explore url: build-recorder
    docker compose run --rm --no-deps recorder explore "$1"

# Three independent responsive Chromium runs with separate evidence and usage.
explore-matrix url: build-recorder
    docker compose run --rm --no-deps recorder explore-matrix "$1"

# One fresh-browser verification per completed suspect; repeated calls reuse it.
reproduce action_id: build-recorder
    docker compose run --rm --no-deps recorder reproduce "$1"

# Real browser/storage/gateway, simulated providers. No real model charges.
explorer-test:
    bash scripts/test-explorer.sh

# Recheck every open issue against a deployment and wait; exits non-zero on regressions (CI-friendly).
recheck candidate_url:
    node scripts/scout-recheck.mjs --candidate "$1"

# Browser sandbox: no Scout credentials or storage network, Chromium sandbox on, one run per container.
isolation-test:
    bash scripts/test-browser-isolation.sh

# Persistent issue → candidate fix: API/MCP, real Chromium/evidence, simulated models.
fix-verification-test:
    bash scripts/test-fix-verification.sh

# Focused private-login and saved-session tests with simulated models.
access-test:
    bash scripts/test-explorer.sh test/access.test.ts

# Queue, active browser, model-call and private-login cancellation.
cancellation-test:
    bash scripts/test-cancellation.sh

# Fresh and populated PostgreSQL schema replay in a disposable container.
# Requires the postgres image built by `just dev` or `docker compose build postgres`.
schema-test:
    bash scripts/test-schema-bootstrap.sh

# Human confirmation/dismissal, evidence integrity and review telemetry recovery.
reviews-test:
    bash scripts/test-finding-reviews.sh

# Bounded automatic rechecks, scheduler recovery and independent batch stop.
auto-reproduction-test:
    bash scripts/test-automatic-reproduction.sh

fixture: build-recorder
    docker compose up -d --no-build --wait exploration-fixture

# Larchwood, a shop with known bugs. Explore it, then score the run with bug-lab-score.
bug-lab: build-recorder
    docker compose up -d --no-build --wait larchwood
    @echo "In Scout, explore http://larchwood:8084 (bugs on) or http://larchwood:8085 (every bug fixed)."
    @echo "On this machine: http://127.0.0.1:18084 and http://127.0.0.1:18085"

# The same shop on this computer, without Docker. Extra flags: --fixed, --bugs id,id, --pair.
bug-lab-local port="4100" *flags:
    node apps/bug-lab/server.mjs --port "$@"

# Found, missed and never-tried bugs for one or more runs of the shop.
bug-lab-score +run_ids:
    node scripts/score-bug-lab.mjs "$@"

# The shop's HTTP and scoring tests, then the Chromium check that every bug is real.
bug-lab-test: build-recorder
    node --test apps/bug-lab/test/*.test.mjs
    docker compose run --rm --no-deps -e SCOUT_BROWSER_ENDPOINT= --entrypoint ./node_modules/.bin/tsx recorder --test test/bug-lab.test.ts

graph run_id:
    node scripts/api-read.mjs "/v1/runs/$1/graph"

runtime-test: build-recorder
    docker compose run --rm --no-deps --entrypoint npm recorder run check
    docker compose run --rm --no-deps -e SCOUT_BROWSER_ENDPOINT= --entrypoint npm recorder test

# The stack must already be running; all generated fixture evidence is retained.
test: api-test runtime-test web-test
    npm test --prefix scripts
    npm ci --prefix packages/image-diff --ignore-scripts --no-audit --no-fund
    npm test --prefix packages/image-diff
    node scripts/verify-api.mjs
    node scripts/verify-local.mjs

# Pair this machine's agent using explicit approval in the workspace browser.
mcp-login: mcp-build
    @apps/api/target/release/scout-mcp login

# Revoke the saved agent credential and remove its private local file.
mcp-logout:
    @apps/api/target/release/scout-mcp logout

# Browser pairing, private credentials, history, usage and cross-team isolation.
identity-test:
    bash scripts/test-agent-identity.sh

# Browser OAuth lifecycle with isolated workspaces; does not request inference.
oauth-test:
    node scripts/verify-agent-oauth.mjs

# Active testing focus: real browser/model fixture, then REST/MCP validation without inference.
steering-test:
    bash scripts/test-explorer.sh test/steering.test.ts test/frontier-planner.test.ts
    node scripts/verify-steering.mjs
