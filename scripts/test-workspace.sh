#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Do not interrupt user work to enter simulated provider mode.
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
node scripts/verify-workspace.mjs
node scripts/verify-access-workspace.mjs
