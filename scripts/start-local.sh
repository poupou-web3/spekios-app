#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/setup-local.mjs
npm ci --prefix scripts --ignore-scripts --no-audit --no-fund
docker compose up -d --build --wait --wait-timeout 60
node scripts/bootstrap-local.mjs
node scripts/wait-api.mjs
