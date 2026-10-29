#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/require-idle.mjs
restore() {
  docker compose stop browser-worker
  docker compose -f compose.yaml -f compose.model-test.yaml rm -s -f model-fixture
  docker compose up -d --no-build --wait --wait-timeout 90 api browser-worker
  node scripts/wait-api.mjs
}
trap restore EXIT
docker compose stop browser-worker
node scripts/bootstrap-local.mjs
docker compose build recorder api
docker compose -f compose.yaml -f compose.model-test.yaml up -d --build --wait --wait-timeout 90 api model-fixture exploration-fixture browser-worker
node scripts/wait-api.mjs
docker compose run --rm --no-deps --entrypoint npm recorder run check
docker compose run --rm --no-deps --entrypoint ./node_modules/.bin/tsx recorder --test test/fix-verification.test.ts
node scripts/verify-fix-verification.mjs
restore
trap - EXIT
node scripts/verify-agent-interface.mjs --normal-mode
node scripts/require-idle.mjs
