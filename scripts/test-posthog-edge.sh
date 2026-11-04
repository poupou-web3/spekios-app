#!/usr/bin/env bash
# Disposable TLS/AOP + actual demo image. No production connection or Cloud events.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture="spekios-posthog-edge-test-$$"
scratch=$(mktemp -d)
cleanup() {
  result=$?
  if [[ "$result" != 0 ]]; then
    docker logs "$fixture-edge" 2>&1 || true
    docker logs "$fixture-demo" 2>&1 || true
  fi
  docker rm -f "$fixture-edge" "$fixture-demo" >/dev/null 2>&1 || true
  docker network rm "$fixture" >/dev/null 2>&1 || true
  docker image rm "$fixture" >/dev/null 2>&1 || true
  rm -rf "$scratch"
  exit "$result"
}
trap cleanup EXIT
mkdir -p "$scratch/certs" "$scratch/demo-certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Local AOP test CA' \
  -keyout "$scratch/ca.key" -out "$scratch/certs/aop-ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=Local Cloudflare client fixture' \
  -keyout "$scratch/client.key" -out "$scratch/client.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -in "$scratch/client.csr" -CA "$scratch/certs/aop-ca.pem" \
  -CAkey "$scratch/ca.key" -CAcreateserial -out "$scratch/client.pem" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=demo-posthog.spekios.com' \
  -addext 'subjectAltName=DNS:demo-posthog.spekios.com' \
  -keyout "$scratch/demo-certs/origin.key" -out "$scratch/demo-certs/origin.pem" >/dev/null 2>&1
cat > "$scratch/Caddyfile" <<'EOF'
{
  admin off
  auto_https disable_redirects
  servers {
    strict_sni_host on
  }
}
import /etc/caddy/posthog.caddy
EOF
image="${SCOUT_CADDY_TEST_IMAGE:-caddy:2-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5}"
docker compose --env-file /dev/null -f apps/posthog-demo/compose.yaml -f apps/posthog-demo/compose.public.yaml config --quiet
SCOUT_API_TOKEN=fixture POSTGRES_PASSWORD=fixture S3_ACCESS_KEY_ID=fixture S3_SECRET_ACCESS_KEY=fixture \
CLICKHOUSE_PASSWORD=fixture SCOUT_EDGE_CERT_DIR="$scratch/certs" SCOUT_BACKOFFICE_HOST=bo.fixture.test \
SCOUT_POSTHOG_DEMO_CERT_DIR="$scratch/demo-certs" docker compose --env-file /dev/null \
  -f compose.yaml -f compose.deploy.yaml -f compose.edge-origin.yaml -f compose.posthog-demo-edge.yaml config --quiet
docker build -q -t "$fixture" -f apps/posthog-demo/Dockerfile . >/dev/null
docker network create "$fixture" >/dev/null
docker run -d --name "$fixture-demo" --network "$fixture" --network-alias posthog-demo-site \
  --read-only --cap-drop ALL --security-opt no-new-privileges --memory 128m "$fixture" >/dev/null
docker run --rm --network "$fixture" \
  -v "$scratch/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$PWD/infra/edge/Caddyfile.posthog-demo:/etc/caddy/posthog.caddy:ro" \
  -v "$scratch/certs:/certs:ro" -v "$scratch/demo-certs:/posthog-demo-certs:ro" \
  "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
docker run -d --name "$fixture-edge" --network "$fixture" \
  -p '127.0.0.1::443' --read-only --tmpfs /data --tmpfs /config \
  --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges --memory 128m \
  -v "$scratch/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$PWD/infra/edge/Caddyfile.posthog-demo:/etc/caddy/posthog.caddy:ro" \
  -v "$scratch/certs:/certs:ro" -v "$scratch/demo-certs:/posthog-demo-certs:ro" \
  "$image" >/dev/null
port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "443/tcp") 0).HostPort}}' "$fixture-edge")
request=(curl --silent --show-error --noproxy '*' --max-time 3 \
  --resolve "demo-posthog.spekios.com:$port:127.0.0.1" --cacert "$scratch/demo-certs/origin.pem")
for ((attempt=0; attempt<30; attempt++)); do
  if "${request[@]}" --cert "$scratch/client.pem" --key "$scratch/client.key" \
    "https://demo-posthog.spekios.com:$port/healthz" > "$scratch/health.json" 2>/dev/null; then break; fi
  sleep 1
done
node -e 'const fs=require("fs");if(JSON.parse(fs.readFileSync(process.argv[1])).service!=="posthog-demo")process.exit(1)' "$scratch/health.json"
"${request[@]}" --cert "$scratch/client.pem" --key "$scratch/client.key" \
  "https://demo-posthog.spekios.com:$port/" > "$scratch/page.html"
rg -q Fieldwork "$scratch/page.html"
if "${request[@]}" "https://demo-posthog.spekios.com:$port/healthz" >/dev/null 2>&1; then
  echo 'Origin incorrectly accepted a connection without the AOP client certificate.' >&2
  exit 1
fi
echo 'Demo certificate, HTTPS routing and authenticated origin pulls verified locally.'
