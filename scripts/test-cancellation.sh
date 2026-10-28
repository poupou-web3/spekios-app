#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/require-idle.mjs
restore() {
  docker compose stop browser-worker
  docker compose -f compose.yaml -f compose.model-test.yaml rm -s -f model-fixture
  docker compose up -d --no-build --wait --wait-timeout 60 api browser-worker
  node scripts/wait-api.mjs
}
trap restore EXIT
docker compose stop browser-worker
node scripts/bootstrap-local.mjs
docker compose -f compose.yaml -f compose.model-test.yaml up -d --build --wait --wait-timeout 90 api model-fixture exploration-fixture browser-worker
node scripts/wait-api.mjs
node scripts/verify-cancellation.mjs
docker compose stop browser-worker
docker compose run --rm --no-deps -e SCOUT_EXPLORER_INTEGRATION=1 --entrypoint ./node_modules/.bin/tsx recorder --test test/cancellation.test.ts
