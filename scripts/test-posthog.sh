#!/usr/bin/env bash
# Disposable database and real local Chromium. Never uses the product .env/DB.
set -euo pipefail
cd "$(dirname "$0")/.."
container="spekios-posthog-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$container" --tmpfs /var/lib/postgresql/data \
  -p '127.0.0.1::5432' -e POSTGRES_USER=scout -e POSTGRES_DB=scout \
  -e 'PGOPTIONS=-c client_min_messages=warning' \
  -e POSTGRES_PASSWORD=posthog-disposable-fixture \
  "${SCOUT_SCHEMA_TEST_IMAGE:-scout-qa-postgres:local}" >/dev/null
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U scout -d scout >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U scout -d scout >/dev/null
for file in infra/postgres/*.sql; do
  docker exec -i "$container" psql -X -q -U scout -d scout -v ON_ERROR_STOP=1 -f - <"$file" >/dev/null
done
export PGHOST=127.0.0.1 PGUSER=scout PGDATABASE=scout PGSSLMODE=disable
export PGPORT="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container")"
export POSTGRES_PASSWORD=posthog-disposable-fixture
export SPEKIOS_POSTHOG_TEST_DB=1 SPEKIOS_POSTHOG_WORKER_TEST_DB=1
export SCOUT_POSTHOG_HOSTS=http://posthog.invalid SCOUT_POSTHOG_REPLAY_ORIGINS=http://demo.invalid
export SCOUT_PROVIDER_VAULT_KEY=1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f
cargo ${SCOUT_TEST_RUST_TOOLCHAIN:+"+$SCOUT_TEST_RUST_TOOLCHAIN"} test --manifest-path apps/api/Cargo.toml --locked posthog::tests -- --include-ignored
node --test apps/posthog-demo/test/*.test.mjs
(cd packages/browser-runtime && node --import tsx --test test/posthog.test.ts test/posthog-browser.test.ts test/posthog-worker.test.ts test/posthog-ui-browser.test.ts)
