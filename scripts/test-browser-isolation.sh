#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The check takes the sandbox's single client slot; never compete with a run.
node scripts/require-idle.mjs
docker compose build recorder
docker compose up -d --no-build --wait --wait-timeout 90 browser-sandbox exploration-fixture browser-worker
node scripts/verify-browser-isolation.mjs
