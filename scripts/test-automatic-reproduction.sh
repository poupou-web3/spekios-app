#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/require-idle.mjs
restore() {
  docker compose unpause browser-worker 2>/dev/null || true
  docker compose stop browser-worker
  docker compose -f compose.yaml -f compose.model-test.yaml rm -s -f model-fixture
  docker compose up -d --no-build --wait --wait-timeout 60 api browser-worker
  node scripts/wait-api.mjs
}
trap restore EXIT
docker compose stop browser-worker
node scripts/bootstrap-local.mjs
docker compose build recorder
docker compose -f compose.yaml -f compose.model-test.yaml up -d --build --wait --wait-timeout 90 api model-fixture exploration-fixture
node scripts/wait-api.mjs
docker compose run --rm --no-deps --entrypoint npm recorder run check
docker compose run --rm --no-deps -e SCOUT_EXPLORER_INTEGRATION=1 -e SCOUT_BROWSER_ENDPOINT= --entrypoint ./node_modules/.bin/tsx recorder --test test/automatic-reproduction.test.ts
docker compose -f compose.yaml -f compose.model-test.yaml up -d --no-build --wait --wait-timeout 90 browser-worker
node scripts/verify-automatic-reproduction.mjs
