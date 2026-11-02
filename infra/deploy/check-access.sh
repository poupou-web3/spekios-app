#!/usr/bin/env bash
# Read-only check that HCLOUD_TOKEN and CLOUDFLARE_API_TOKEN can do what
# `just cloud-apply` needs. Makes only GET requests and never prints a token.
# Usage: infra/deploy/check-access.sh [zone] [image] [server type] [location]
# Without arguments, server type and location come from terraform.tfvars
# (falling back to the variables.tf defaults).
set -uo pipefail

tfvar() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\1/p" \
    "$(dirname "$0")/terraform/terraform.tfvars" 2>/dev/null | tail -n 1
}
zone=${1:-spekios.com}
image=${2:-debian-13}
server_type=${3:-$(tfvar server_type)}
server_type=${server_type:-cx43}
location=${4:-$(tfvar location)}
location=${location:-nbg1}
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
  status=$(get "$HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/images?name=$image")
  if [[ "$status" == 200 && "$(json "len(d['images'])")" -gt 0 ]]; then
    ok "token works; image '$image' exists ($(json "' and '.join(sorted({i['architecture'] for i in d['images']}))"))"
  elif [[ "$status" == 200 ]]; then
    bad "token works, but no image named '$image' (set image in terraform.tfvars)"
  else
    bad "token rejected (HTTP $status): create a Read & Write token in the project"
  fi

  # Hetzner sometimes runs out of a server type in one location
  # ("resource_unavailable" on apply). Since 1 Oct 2026 availability is on each
  # server type (server_types[].locations[].available; /v1/datacenters is 410
  # Gone). Hetzner calls it an indicator, not a guarantee.
  if [[ "$status" == 200 ]]; then
    status=$(get "$HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/server_types?per_page=50")
    if [[ "$status" != 200 ]]; then
      bad "could not list server types (HTTP $status)"
    else
      result=$(python3 - "$body" "$server_type" "$location" <<'PY'
import json, sys
path, wanted, location = sys.argv[1:4]
types = json.load(open(path)).get("server_types", [])

def stock(t):
    """Locations where this type can be ordered now (not deprecated, available)."""
    where = set()
    for loc in t.get("locations") or []:
        name = loc.get("name") or (loc.get("location") or {}).get("name")
        if name and loc.get("available") and loc.get("deprecation") is None:
            where.add(name)
    return sorted(where)

def monthly(t, where):
    prices = {}
    for p in t.get("prices") or []:
        try:
            prices[p["location"]] = float(p["price_monthly"]["net"])
        except (KeyError, TypeError, ValueError):
            pass
    found = [prices[l] for l in where if l in prices]
    return min(found) if found else None

chosen = next((t for t in types if t.get("name") == wanted), None)
if not types:
    print("FAIL|the API returned no server types (format changed?)")
elif chosen is None:
    print(f"FAIL|no server type named '{wanted}'")
else:
    where = stock(chosen)
    if location in where:
        others = " ".join(l for l in where if l != location) or "none"
        print(f"OK|{wanted} available in {location} (also: {others})")
    elif where:
        print(f"FAIL|{wanted} is not available in {location} right now; available in: {' '.join(where)}. Set location in terraform.tfvars")
    else:
        print(f"FAIL|{wanted} is not available in any location right now")

    if location not in where:
        rows = []
        for t in types:
            if t.get("cores", 0) < 8 or t.get("memory", 0) < 16:
                continue
            w = stock(t)
            if w:
                rows.append((monthly(t, w) or 1e9, t["name"], t.get("architecture", "?"), t.get("cpu_type", "?"),
                             t["cores"], int(t["memory"]), " ".join(w)))
        print("INFO|In stock now with >= 8 vCPU and 16 GB (set server_type and location in terraform.tfvars):")
        for price, name, arch, cpu, cores, mem, w in sorted(rows):
            shown = f"EUR {price:7.2f}/mo" if price < 1e9 else "price n/a     "
            print(f"INFO|  {name:<7} {arch:<4} {cpu:<9} {cores:>2} vCPU {mem:>3} GB  {shown}  {w}")
        if not rows:
            print("INFO|  none right now; try again later")
PY
      ) || result="FAIL|could not read the server types response"
      while IFS='|' read -r kind text; do
        case "$kind" in
          OK) ok "$text" ;;
          FAIL) bad "$text" ;;
          *) printf '        %s\n' "$text" ;;
        esac
      done <<<"$result"
    fi
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
check "Account: Access: Service Tokens → Edit (GitHub deploys)" "$api/accounts/$account_id/access/service_tokens"
check "Account: Cloudflare Tunnel → Edit (GitHub deploys)" "$api/accounts/$account_id/cfd_tunnel?per_page=1"

status=$(get "$t" "$api/accounts/$account_id/access/organizations")
if [[ "$status" == 200 ]]; then ok "Zero Trust is set up for the account"; else bad "Zero Trust not set up yet (dashboard → Zero Trust → choose the Free plan) or Access permission missing (HTTP $status)"; fi

echo
echo "Read checks can't prove edit rights. Make sure each permission above is set to Edit."
exit $fail
