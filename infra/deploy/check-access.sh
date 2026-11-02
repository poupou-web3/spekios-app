#!/usr/bin/env bash
# Read-only check that HCLOUD_TOKEN and CLOUDFLARE_API_TOKEN can do what
# `just cloud-apply` needs. Makes only GET requests and never prints a token.
# Usage: infra/deploy/check-access.sh [zone] [image]
set -uo pipefail

zone=${1:-spekios.com}
image=${2:-debian-13}
fail=0

ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

# GET with a bearer token; prints the HTTP status, body goes to $body.
body=$(mktemp)
trap 'rm -f "$body"' EXIT
get() { curl -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer $1" "$2" 2>/dev/null || echo 000; }
json() { python3 -c "import json,sys; d=json.load(open('$body')); print($1)" 2>/dev/null; }

echo "Hetzner Cloud"
if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
  bad "HCLOUD_TOKEN is empty (store it with: security add-generic-password -a \"\$USER\" -s spekios-hcloud -w)"
else
  status=$(get "$HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/images?name=$image&architecture=x86")
  if [[ "$status" == 200 && "$(json "len(d['images'])")" -gt 0 ]]; then
    ok "token works; image '$image' exists"
  elif [[ "$status" == 200 ]]; then
    bad "token works, but no x86 image named '$image' (set image in terraform.tfvars)"
  else
    bad "token rejected (HTTP $status): create a Read & Write token in the project"
  fi
fi

echo "Cloudflare"
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  bad "CLOUDFLARE_API_TOKEN is empty (store it with: security add-generic-password -a \"\$USER\" -s spekios-cloudflare -w)"
  exit 1
fi
t=$CLOUDFLARE_API_TOKEN
api=https://api.cloudflare.com/client/v4

status=$(get "$t" "$api/user/tokens/verify")
[[ "$status" == 200 ]] && ok "token is active" || { bad "token invalid or expired (HTTP $status)"; exit 1; }

status=$(get "$t" "$api/zones?name=$zone")
zone_id=$(json "d['result'][0]['id']")
account_id=$(json "d['result'][0]['account']['id']")
if [[ "$status" == 200 && -n "$zone_id" ]]; then ok "Zone → Read ($zone)"; else bad "Zone → Read: cannot see zone $zone (HTTP $status)"; exit 1; fi

# Each permission is checked with a read call it also covers. 401/403 mean
# missing. Any 2xx is allowed (the origin-pull settings endpoint answers 202),
# and 404 on the ruleset entry point just means no Configuration Rules exist yet.
check() {
  local label=$1 url=$2 status
  status=$(get "$t" "$url")
  case "$status" in
    2?? | 404) ok "$label" ;;
    *) bad "$label (HTTP $status)" ;;
  esac
}
check "DNS → Edit" "$api/zones/$zone_id/dns_records?per_page=1"
check "SSL and Certificates → Edit (Origin CA)" "$api/certificates?zone_id=$zone_id"
check "SSL and Certificates → Edit (Authenticated Origin Pulls)" "$api/zones/$zone_id/origin_tls_client_auth/settings"
check "Config Rules → Edit" "$api/zones/$zone_id/rulesets/phases/http_config_settings/entrypoint"
check "Account: Access: Apps and Policies → Edit" "$api/accounts/$account_id/access/apps"

status=$(get "$t" "$api/accounts/$account_id/access/organizations")
if [[ "$status" == 200 ]]; then ok "Zero Trust is set up for the account"; else bad "Zero Trust not set up yet (dashboard → Zero Trust → choose the Free plan) or Access permission missing (HTTP $status)"; fi

echo
echo "Read checks can't prove edit rights. Make sure each permission above is set to Edit."
exit $fail
