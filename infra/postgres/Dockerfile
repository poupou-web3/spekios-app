FROM postgres:17.11-alpine3.23@sha256:9ea644da56f1a82283b173fa38a316636fe7c538991a8ae41998cd3765434991
# Every numbered file in this directory, in name order. A fresh volume runs them
# once; scripts/apply-schemas.sh runs them again on later deploys.
COPY *.sql /docker-entrypoint-initdb.d/
