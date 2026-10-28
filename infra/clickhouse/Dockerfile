FROM clickhouse/clickhouse-server:26.7.35.11-alpine@sha256:873fc769861ad580941afdb852138ba33b45bdba473c182cbbe9746145feb60c
COPY limits.xml /etc/clickhouse-server/config.d/limits.xml
COPY user-limits.xml /etc/clickhouse-server/users.d/user-limits.xml
COPY 001-evidence.sql /docker-entrypoint-initdb.d/001-evidence.sql
COPY 002-runtime.sql /docker-entrypoint-initdb.d/002-runtime.sql
COPY 003-model-gateway.sql /docker-entrypoint-initdb.d/003-model-gateway.sql
