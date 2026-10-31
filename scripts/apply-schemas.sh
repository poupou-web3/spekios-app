#!/usr/bin/env bash
# Apply infra/postgres and infra/clickhouse in filename order.
# Safe to repeat: the SQL files are the same ones used on a fresh database volume.
set -euo pipefail
cd "$(dirname "$0")/.."

shopt -s nullglob
postgres_files=(infra/postgres/*.sql)
clickhouse_files=(infra/clickhouse/*.sql)
if [[ ${#postgres_files[@]} -eq 0 || ${#clickhouse_files[@]} -eq 0 ]]; then
  echo "Schema directories are empty." >&2
  exit 1
fi

for file in "${postgres_files[@]}"; do
  echo "PostgreSQL $(basename "$file")"
  docker compose exec -T postgres \
    psql -X -qAt -U scout -d scout -v ON_ERROR_STOP=1 -f - <"$file"
done

for file in "${clickhouse_files[@]}"; do
  echo "ClickHouse $(basename "$file")"
  docker compose exec -T clickhouse \
    sh -c 'clickhouse-client --host 127.0.0.1 --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --receive_timeout 45 --multiquery' <"$file"
done

echo "PostgreSQL and ClickHouse schemas are ready."
