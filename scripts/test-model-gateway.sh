#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/require-idle.mjs
restore() {
  docker compose -f compose.yaml -f compose.model-test.yaml rm -s -f model-fixture
  docker compose up -d --no-build --wait --wait-timeout 60 api evidence clickhouse browser-worker
}
trap restore EXIT
docker compose stop browser-worker
node scripts/bootstrap-local.mjs
docker compose -f compose.yaml -f compose.model-test.yaml up -d --build --wait --wait-timeout 60 api model-fixture
node scripts/verify-model-gateway.mjs
node scripts/verify-model-journal.mjs
