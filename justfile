set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments

# Show available development commands.
default:
    @"{{just_executable()}}" --list

# Start the API and storage services, preserving existing data and credentials.
up:
    bash scripts/start-local.sh

dev: up

# Start the local workspace and print its URL.
ui: up
    @echo "Scout workspace: http://127.0.0.1:18080"

# Real GUI API/worker integration with simulated models; restores normal mode.
workspace-test:
    bash scripts/test-workspace.sh

# Delayed form journeys, completion, diagnostics and exact replay.
outcomes-test:
    bash scripts/test-explorer.sh test/outcomes.test.ts

web-test:
    node --test apps/web/*.test.mjs

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

# Focused private-login and saved-session tests with simulated models.
access-test:
    bash scripts/test-explorer.sh test/access.test.ts

# Queue, active browser, model-call and private-login cancellation.
cancellation-test:
    bash scripts/test-cancellation.sh

# Human confirmation/dismissal, evidence integrity and review telemetry recovery.
reviews-test:
    bash scripts/test-finding-reviews.sh

# Bounded automatic rechecks, scheduler recovery and independent batch stop.
auto-reproduction-test:
    bash scripts/test-automatic-reproduction.sh

fixture: build-recorder
    docker compose up -d --no-build --wait exploration-fixture

graph run_id:
    node scripts/api-read.mjs "/v1/runs/$1/graph"

runtime-test: build-recorder
    docker compose run --rm --no-deps --entrypoint npm recorder run check
    docker compose run --rm --no-deps --entrypoint npm recorder test

# The stack must already be running; all generated fixture evidence is retained.
test: api-test runtime-test web-test
    npm test --prefix scripts
    npm ci --prefix packages/image-diff --ignore-scripts --no-audit --no-fund
    npm test --prefix packages/image-diff
    node scripts/verify-api.mjs
    node scripts/verify-local.mjs
