#!/usr/bin/env bash
# Uses fresh disposable PostgreSQL databases and fake credentials only. Never
# starts a worker or contacts a model provider. All containers/processes exit.
set -euo pipefail
cd "$(dirname "$0")/.."
container_id=$(docker run --rm -d --tmpfs /var/lib/postgresql/data -p 127.0.0.1::5432 \
  -e POSTGRES_USER=scout -e POSTGRES_DB=provider_access_unit -e POSTGRES_PASSWORD=disposable-provider-access-test postgres:17-alpine)
trap 'docker stop "$container_id" >/dev/null' EXIT
for attempt in {1..30}; do
  if docker exec "$container_id" pg_isready -U scout -d provider_access_unit >/dev/null 2>&1; then break; fi
  sleep 1
done
test_port=$(docker port "$container_id" 5432/tcp | sed 's/.*://')
export PGHOST=127.0.0.1 PGPORT="$test_port" PGUSER=scout PGDATABASE=provider_access_unit POSTGRES_PASSWORD=disposable-provider-access-test
cargo_command=(cargo)
if [[ -n "${SCOUT_TEST_TOOLCHAIN:-}" ]]; then cargo_command+=("+$SCOUT_TEST_TOOLCHAIN"); fi
SPEKIOS_KEYS_TEST_DB=1 "${cargo_command[@]}" test --offline --manifest-path apps/api/Cargo.toml --lib provider_access -- --include-ignored
docker exec "$container_id" createdb -U scout provider_access_e2e
for schema in infra/postgres/*.sql; do
  docker exec -i "$container_id" psql -X -q -U scout -d provider_access_e2e -v ON_ERROR_STOP=1 < "$schema"
done
"${cargo_command[@]}" build --offline --manifest-path apps/api/Cargo.toml --bin scout-api
PGDATABASE=provider_access_e2e SPEKIOS_PROVIDER_E2E=1 node scripts/verify-provider-access.mjs
