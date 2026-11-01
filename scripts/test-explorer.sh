#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/require-idle.mjs
restore() {
  docker compose -f compose.yaml -f compose.model-test.yaml rm -s -f model-fixture
  docker compose up -d --no-build --wait --wait-timeout 60 api browser-worker
  node scripts/wait-api.mjs
}
trap restore EXIT
docker compose stop browser-worker
node scripts/bootstrap-local.mjs
docker compose build recorder
docker compose -f compose.yaml -f compose.model-test.yaml up -d --build --wait --wait-timeout 60 api model-fixture exploration-fixture browser-sandbox
node scripts/wait-api.mjs
docker compose run --rm --no-deps --entrypoint npm recorder run check
# In-process fixtures listen inside the recorder container, so these tests launch
# Chromium there. CLI explorations below use the browser sandbox.
if (( $# )); then
  docker compose run --rm --no-deps -e SCOUT_EXPLORER_INTEGRATION=1 -e SCOUT_BROWSER_ENDPOINT= --entrypoint ./node_modules/.bin/tsx recorder --test --test-concurrency=1 "$@"
  exit 0
fi
docker compose run --rm --no-deps -e SCOUT_EXPLORER_INTEGRATION=1 -e SCOUT_BROWSER_ENDPOINT= --entrypoint ./node_modules/.bin/tsx recorder --test --test-concurrency=1 test/job-queue.test.ts test/frontier-planner.test.ts test/exploration-recovery.test.ts test/recovery.test.ts test/explorer.test.ts test/app-memory.test.ts test/reproduction.test.ts test/interactions.test.ts test/access.test.ts test/outcomes.test.ts test/cancellation.test.ts test/automatic-reproduction.test.ts
node scripts/verify-explorer.mjs
node scripts/verify-reproduction.mjs
node scripts/verify-frontier.mjs
node scripts/verify-interactions.mjs
