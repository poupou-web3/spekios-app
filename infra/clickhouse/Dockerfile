FROM clickhouse/clickhouse-server:26.7.35.11-alpine@sha256:873fc769861ad580941afdb852138ba33b45bdba473c182cbbe9746145feb60c
COPY limits.xml /etc/clickhouse-server/config.d/limits.xml
COPY user-limits.xml /etc/clickhouse-server/users.d/user-limits.xml
# Every numbered file in this directory, in name order. A fresh volume runs them
# once; scripts/apply-schemas.sh runs them again on later deploys.
COPY *.sql /docker-entrypoint-initdb.d/
