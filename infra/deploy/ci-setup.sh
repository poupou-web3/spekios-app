#!/usr/bin/env bash
# Set up deploys on every push to prod (.github/workflows/deploy.yml).
# Run from your machine after `just cloud-apply`:
#   1. creates a dedicated deploy key (~/.ssh/spekios_github_deploy, no passphrase),
#   2. installs cloudflared on the server and authorizes that key through the tunnel only,
#   3. checks an SSH login through the tunnel, the way GitHub will make it,
#   4. stores what the workflow needs as GitHub Actions secrets and variables.
# Run it again after changing ansible/secrets.yml, rotating the service token,
# or recreating the server. Never prints a secret.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
deploy=infra/deploy
tf=$(command -v tofu || command -v terraform) || { echo "Install OpenTofu (brew install opentofu)." >&2; exit 1; }
command -v gh >/dev/null || { echo "Install the GitHub CLI (brew install gh)." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run gh auth login first." >&2; exit 1; }
repo=${SCOUT_GITHUB_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}

out() { "$tf" -chdir="$deploy/terraform" output -raw "$1" 2>/dev/null; }
ssh_host=$(out deploy_ssh_host) || { echo "Terraform has no deploy_ssh_host output: run just cloud-apply first." >&2; exit 1; }
ip=$(out server_ipv4)
public_host=$(out public_url); public_host=${public_host#https://}
bo_host=$(out backoffice_url); bo_host=${bo_host#https://}
client_id=$(out deploy_access_client_id)
client_secret=$(out deploy_access_client_secret)
admin_key=${SCOUT_SSH_KEY:-$HOME/.ssh/spekios_hetzner}
ci_key=${SCOUT_CI_SSH_KEY:-$HOME/.ssh/spekios_github_deploy}
secrets_yml=$deploy/ansible/secrets.yml

for f in origin.pem origin.key aop-ca.pem tunnel-token; do
  [[ -f $deploy/.secrets/$f ]] || { echo "Missing $deploy/.secrets/$f: run just cloud-apply first." >&2; exit 1; }
done
# shellcheck disable=SC2016 # a literal $ANSIBLE_VAULT header
if [[ -f $secrets_yml ]] && head -c 14 "$secrets_yml" | grep -q '^\$ANSIBLE_VAULT'; then
  echo "$secrets_yml is vault-encrypted and GitHub can't decrypt it. Decrypt it (ansible-vault decrypt) before running this." >&2
  exit 1
fi

echo "== Deploy key"
if [[ -f $ci_key ]]; then
  echo "Using $ci_key"
else
  ssh-keygen -q -t ed25519 -N '' -C "scout-github-deploy@$repo" -f "$ci_key"
  echo "Created $ci_key (no passphrase: GitHub Actions uses it unattended)"
fi

echo "== Server: cloudflared and the deploy key"
(cd "$deploy/ansible" && SCOUT_CI_SSH_KEY="$ci_key" ansible-playbook site.yml --tags tunnel)

# Pin the server's host keys under the tunnel hostname. They're read over your
# own SSH connection, which has already verified this host.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ssh -i "$admin_key" -o BatchMode=yes -o ConnectTimeout=15 "deploy@$ip" 'cat /etc/ssh/ssh_host_*_key.pub' |
  awk -v h="$ssh_host" '{ print h, $1, $2 }' >"$work/known_hosts"
[[ -s $work/known_hosts ]] || { echo "Could not read the server's host keys." >&2; exit 1; }

echo "== SSH through the tunnel ($ssh_host)"
if command -v cloudflared >/dev/null; then
  ok=0
  for _ in 1 2 3 4 5 6; do
    if TUNNEL_SERVICE_TOKEN_ID=$client_id TUNNEL_SERVICE_TOKEN_SECRET=$client_secret \
      ssh -i "$ci_key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 \
        -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes \
        -o ProxyCommand='cloudflared access ssh --hostname %h --service-token-id "$TUNNEL_SERVICE_TOKEN_ID" --service-token-secret "$TUNNEL_SERVICE_TOKEN_SECRET"' \
        "deploy@$ssh_host" true 2>"$work/ssh.log"; then
      ok=1; break
    fi
    sleep 10
  done
  if [[ $ok == 1 ]]; then
    echo "ok: the deploy key logs in through the tunnel"
  else
    echo "SSH through the tunnel failed:" >&2; cat "$work/ssh.log" >&2
    echo "On the server: sudo journalctl -u scout-ssh-tunnel -n 50" >&2
    exit 1
  fi
else
  echo "skipped (brew install cloudflared to check it from here); the first workflow run will check it"
fi

echo "== GitHub Actions secrets and variables ($repo)"
secret() { gh secret set "$1" --repo "$repo" >/dev/null && echo "secret   $1"; }
variable() { gh variable set "$1" --repo "$repo" --body "$2" >/dev/null && echo "variable $1=$2"; }
secret DEPLOY_SSH_KEY <"$ci_key"
secret DEPLOY_KNOWN_HOSTS <"$work/known_hosts"
printf '%s' "$client_id" | secret CF_ACCESS_CLIENT_ID
printf '%s' "$client_secret" | secret CF_ACCESS_CLIENT_SECRET
secret ORIGIN_PEM <"$deploy/.secrets/origin.pem"
secret ORIGIN_KEY <"$deploy/.secrets/origin.key"
secret AOP_CA_PEM <"$deploy/.secrets/aop-ca.pem"
if [[ -f $secrets_yml ]]; then
  secret ANSIBLE_SECRETS_YML <"$secrets_yml"
else
  gh secret delete ANSIBLE_SECRETS_YML --repo "$repo" >/dev/null 2>&1 || true
  echo "secret   ANSIBLE_SECRETS_YML (none: no $secrets_yml)"
fi
variable DEPLOY_SSH_HOST "$ssh_host"
variable SCOUT_PUBLIC_HOST "$public_host"
variable SCOUT_BACKOFFICE_HOST "$bo_host"

echo
echo "Done. Every push to prod now deploys: just release ships the commit you have checked out."
echo "Runs: https://github.com/$repo/actions/workflows/deploy.yml"
