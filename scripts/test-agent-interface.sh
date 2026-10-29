#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Do not interrupt a person's browser/model work to enter fixture mode.
node scripts/require-idle.mjs
cargo build --locked --manifest-path apps/api/Cargo.toml --bin scout-mcp
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
node scripts/verify-agent-interface.mjs
restore
trap - EXIT
node scripts/verify-agent-interface.mjs --normal-mode
