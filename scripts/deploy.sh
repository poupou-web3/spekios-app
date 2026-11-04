#!/usr/bin/env bash
# Start the workspace, operator console, API, browser workers and databases.
# Usage: scripts/deploy.sh [edge]
set -euo pipefail
cd "$(dirname "$0")/.."

edge=0
case "${1:-}" in
  "") ;;
  edge | --edge) edge=1 ;;
  *)
    echo "Usage: scripts/deploy.sh [edge]" >&2
    exit 2
    ;;
esac

if command -v node >/dev/null 2>&1; then
  node scripts/setup-local.mjs
elif [[ ! -f .env ]]; then
  umask 077
  token() { openssl rand -hex 32; }
  cat >.env <<EOF
# Created by scripts/deploy.sh. Keep private.
POSTGRES_PASSWORD=$(token)
S3_ACCESS_KEY_ID=$(token)
S3_SECRET_ACCESS_KEY=$(token)
CLICKHOUSE_PASSWORD=$(token)
SCOUT_API_TOKEN=$(token)
EOF
  chmod 600 .env
  echo "Created .env with independent random credentials and permissions 0600."
else
  chmod 600 .env
fi

read_env() {
  local key="$1" line
  line=$(grep -E "^${key}=" .env | tail -n 1 || true)
  line=${line%$'\r'}
  printf '%s' "${line#"${key}"=}"
}

if [[ -z "$(read_env SCOUT_PROVIDER_VAULT_KEY)" ]]; then
  umask 077
  printf '\nSCOUT_PROVIDER_VAULT_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
fi

export COMPOSE_FILE="compose.yaml:compose.deploy.yaml"
export SCOUT_PUBLISH="${SCOUT_PUBLISH:-127.0.0.1}"

bypass=$(read_env SCOUT_DEV_AUTH_BYPASS)
if [[ "$edge" == 1 ]]; then
  host=$(read_env SCOUT_PUBLIC_HOST)
  origin=$(read_env SCOUT_PUBLIC_ORIGIN)
  if [[ -z "$host" || -z "$origin" ]]; then
    echo "Set SCOUT_PUBLIC_HOST and SCOUT_PUBLIC_ORIGIN in .env before deploying the HTTPS edge." >&2
    exit 1
  fi
  if [[ "$origin" != https://* ]]; then
    echo "SCOUT_PUBLIC_ORIGIN must be an https origin." >&2
    exit 1
  fi
  if [[ "$bypass" == "true" ]]; then
    echo "Refusing the HTTPS edge while SCOUT_DEV_AUTH_BYPASS=true." >&2
    exit 1
  fi
  export SCOUT_PUBLIC_HOST="$host"
  export SCOUT_PUBLIC_ORIGIN="$origin"
  export SCOUT_EDGE_PUBLISH="${SCOUT_EDGE_PUBLISH:-0.0.0.0}"
  edge_tls=$(read_env SCOUT_EDGE_TLS)
  case "${edge_tls:-acme}" in
    acme) ;;
    origin)
      cert_dir=$(read_env SCOUT_EDGE_CERT_DIR)
      if [[ -z "$cert_dir" || ! -f "$cert_dir/origin.pem" || ! -f "$cert_dir/origin.key" || ! -f "$cert_dir/aop-ca.pem" ]]; then
        echo "SCOUT_EDGE_TLS=origin needs SCOUT_EDGE_CERT_DIR with origin.pem, origin.key and aop-ca.pem." >&2
        exit 1
      fi
      backoffice_host=$(read_env SCOUT_BACKOFFICE_HOST)
      if [[ ! "$backoffice_host" =~ ^[A-Za-z0-9.-]+$ || "$backoffice_host" == "$host" ]]; then
        echo "SCOUT_EDGE_TLS=origin needs SCOUT_BACKOFFICE_HOST: a bare hostname, different from SCOUT_PUBLIC_HOST, behind Cloudflare Access." >&2
        exit 1
      fi
      export SCOUT_BACKOFFICE_HOST="$backoffice_host"
      COMPOSE_FILE="$COMPOSE_FILE:compose.edge-origin.yaml"
      ;;
    *)
      echo "SCOUT_EDGE_TLS must be acme or origin." >&2
      exit 1
      ;;
  esac
fi
demo_sites=$(read_env SCOUT_DEMO_SITES)
if [[ "$demo_sites" == "true" ]]; then
  [[ "$edge" == 1 && "${edge_tls:-}" == origin ]] || { echo "Demo sites require the Cloudflare Origin HTTPS edge." >&2; exit 1; }
  fixed_host=$(read_env SCOUT_DEMO_FIXED_HOST)
  faulty_host=$(read_env SCOUT_DEMO_FAULTY_HOST)
  for demo_host in "$fixed_host" "$faulty_host"; do
    [[ "$demo_host" =~ ^[a-zA-Z0-9.-]+$ && "$demo_host" == *.* && "$demo_host" != "$host" && "$demo_host" != "$backoffice_host" ]] || { echo "Set distinct valid demo hostnames." >&2; exit 1; }
  done
  [[ "$fixed_host" != "$faulty_host" ]] || { echo "The fixed and faulty demos need separate hostnames." >&2; exit 1; }
  export SCOUT_DEMO_FIXED_HOST="$fixed_host" SCOUT_DEMO_FAULTY_HOST="$faulty_host"
  COMPOSE_FILE="$COMPOSE_FILE:compose.demos.yaml"
fi
if [[ "$bypass" == "true" && "$SCOUT_PUBLISH" != "127.0.0.1" ]]; then
  echo "Refusing to publish the workspace while SCOUT_DEV_AUTH_BYPASS=true." >&2
  exit 1
fi

# The log collector reads container output through a proxy that runs as the
# Docker socket's group. Docker Desktop's socket is group 0, the default.
if [[ -z "${SCOUT_DOCKER_GID:-}" && "$(uname -s)" == Linux ]]; then
  socket="${SCOUT_DOCKER_SOCKET:-/var/run/docker.sock}"
  if [[ -S "$socket" ]]; then
    SCOUT_DOCKER_GID=$(stat -c %g "$socket")
    export SCOUT_DOCKER_GID
  fi
fi

echo "Starting PostgreSQL, ClickHouse and evidence storage."
docker compose up -d --build --wait postgres evidence clickhouse

bash scripts/apply-schemas.sh

echo "Starting the workspace, operator console, API, browser workers and log collector."
echo "The first build compiles the API and the browser image."
if [[ "$edge" == 1 ]]; then
  docker compose --profile edge up -d --build --wait \
    api backoffice browser-worker browser-sandbox log-socket log-collector edge
else
  docker compose up -d --build --wait \
    api backoffice browser-worker browser-sandbox log-socket log-collector
fi

workspace_port="${SCOUT_WORKSPACE_PORT:-18080}"
backoffice_port="${SCOUT_BACKOFFICE_PORT:-18083}"
if [[ "$SCOUT_PUBLISH" == "127.0.0.1" ]]; then
  echo "Workspace: http://127.0.0.1:${workspace_port}"
else
  echo "Workspace listens on port ${workspace_port} (${SCOUT_PUBLISH})."
fi
echo "Operator console (this machine only): http://127.0.0.1:${backoffice_port}"
if [[ "$edge" == 1 ]]; then
  echo "Public workspace: ${origin}"
elif [[ "$SCOUT_PUBLISH" != "127.0.0.1" ]]; then
  echo "This publish address has no TLS. Run scripts/deploy.sh edge after setting SCOUT_PUBLIC_HOST and SCOUT_PUBLIC_ORIGIN."
fi
if [[ "$demo_sites" == true ]]; then
  echo "Fixed demo: https://${fixed_host}"
  echo "Faulty demo: https://${faulty_host}"
fi
echo "PostgreSQL, ClickHouse and the evidence bucket stay on the Compose network. Their host ports are loopback-only."
