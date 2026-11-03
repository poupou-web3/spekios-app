#!/usr/bin/env bash
# Isolated PostgreSQL + real gateway + Chromium; only a local model fixture is used.
set -euo pipefail
cd "$(dirname "$0")/.."
container_id=$(docker run --rm -d --tmpfs /var/lib/postgresql/data -p 127.0.0.1::5432 \
  -e POSTGRES_USER=scout -e POSTGRES_DB=scout -e POSTGRES_PASSWORD=disposable-computer-use-test postgres:17-alpine)
trap 'docker stop "$container_id" >/dev/null' EXIT
ready=false
for attempt in {1..30}; do
  if docker exec "$container_id" psql -h 127.0.0.1 -U scout -d scout -Atc 'SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'Disposable database did not start.' >&2; exit 1; fi
for schema in infra/postgres/*.sql; do
  docker exec -i "$container_id" psql -X -q -U scout -d scout -v ON_ERROR_STOP=1 < "$schema"
done
export PGHOST=127.0.0.1 PGPORT="$(docker port "$container_id" 5432/tcp | sed 's/.*://')" PGUSER=scout PGDATABASE=scout POSTGRES_PASSWORD=disposable-computer-use-test
cargo_command=(cargo)
if [[ -n "${SCOUT_TEST_TOOLCHAIN:-}" ]]; then cargo_command+=("+$SCOUT_TEST_TOOLCHAIN"); fi
"${cargo_command[@]}" build --offline --manifest-path apps/api/Cargo.toml --bin scout-api
SCOUT_COMPUTER_E2E=1 packages/browser-runtime/node_modules/.bin/tsx scripts/verify-computer-use.ts
