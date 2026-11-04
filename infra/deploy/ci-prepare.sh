#!/usr/bin/env bash
# GitHub Actions only (.github/workflows/deploy.yml). Writes the files that
# `ansible-playbook site.yml --tags app` reads on a laptop, from the secrets and
# variables `just cloud-ci-setup` stored: the deploy key and pinned host keys,
# an SSH route through the Cloudflare Tunnel, the inventory, the certificates
# and secrets.yml. Every file is private to the runner user.
set -euo pipefail

for v in DEPLOY_SSH_HOST SCOUT_PUBLIC_HOST SCOUT_BACKOFFICE_HOST DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS \
  ORIGIN_PEM ORIGIN_KEY AOP_CA_PEM; do
  [[ -n "${!v:-}" ]] || { echo "::error::$v is not set. Run just cloud-ci-setup on your machine." >&2; exit 1; }
done

demo_sites=${SCOUT_DEMO_SITES:-false}
[[ "$demo_sites" == true || "$demo_sites" == false ]] || { echo '::error::SCOUT_DEMO_SITES must be true or false.' >&2; exit 1; }
if [[ "$demo_sites" == true ]]; then
  for v in SCOUT_DEMO_FIXED_HOST SCOUT_DEMO_FAULTY_HOST DEMO_ORIGIN_PEM; do
    [[ -n "${!v:-}" ]] || { echo "::error::$v is required for demo sites." >&2; exit 1; }
  done
fi
for demo_host in "${SCOUT_DEMO_FIXED_HOST:-}" "${SCOUT_DEMO_FAULTY_HOST:-}"; do
  [[ -z "$demo_host" || "$demo_host" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo '::error::Invalid demo hostname.' >&2; exit 1; }
done

deploy=$(cd "$(dirname "$0")" && pwd)
umask 077
mkdir -p "$HOME/.ssh" "$deploy/.secrets"

printf '%s\n' "$DEPLOY_SSH_KEY" >"$HOME/.ssh/scout_deploy"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" >"$HOME/.ssh/scout_known_hosts"
# The service token stays out of this file: the workflow sets
# TUNNEL_SERVICE_TOKEN_ID/SECRET on the deploy step, and the ProxyCommand
# inherits them through Ansible and ssh.
cat >"$HOME/.ssh/config" <<EOF
Host $DEPLOY_SSH_HOST
  User deploy
  IdentityFile $HOME/.ssh/scout_deploy
  IdentitiesOnly yes
  UserKnownHostsFile $HOME/.ssh/scout_known_hosts
  StrictHostKeyChecking yes
  ServerAliveInterval 30
  ProxyCommand cloudflared access ssh --hostname %h --service-token-id "\$TUNNEL_SERVICE_TOKEN_ID" --service-token-secret "\$TUNNEL_SERVICE_TOKEN_SECRET"
EOF

cat >"$deploy/ansible/inventory.yml" <<EOF
scout:
  hosts:
    scout-prod:
      ansible_host: "$DEPLOY_SSH_HOST"
      ansible_user: deploy
      ansible_ssh_private_key_file: "$HOME/.ssh/scout_deploy"
      scout_public_host: "$SCOUT_PUBLIC_HOST"
      scout_backoffice_host: "$SCOUT_BACKOFFICE_HOST"
      scout_demo_sites: $demo_sites
      scout_demo_fixed_host: "${SCOUT_DEMO_FIXED_HOST:-}"
      scout_demo_faulty_host: "${SCOUT_DEMO_FAULTY_HOST:-}"
EOF

printf '%s\n' "$ORIGIN_PEM" >"$deploy/.secrets/origin.pem"
printf '%s\n' "$ORIGIN_KEY" >"$deploy/.secrets/origin.key"
printf '%s\n' "$AOP_CA_PEM" >"$deploy/.secrets/aop-ca.pem"
if [[ "$demo_sites" == true ]]; then
  printf '%s\n' "$DEMO_ORIGIN_PEM" >"$deploy/.secrets/demo-origin.pem"
fi
if [[ -n "${POSTHOG_ORIGIN_PEM:-}" || -n "${POSTHOG_ORIGIN_KEY:-}" ]]; then
  [[ -n "${POSTHOG_ORIGIN_PEM:-}" && -n "${POSTHOG_ORIGIN_KEY:-}" ]] || { echo '::error::Both PostHog demo certificate files are required.' >&2; exit 1; }
  printf '%s\n' "$POSTHOG_ORIGIN_PEM" >"$deploy/.secrets/posthog-origin.pem"
  printf '%s\n' "$POSTHOG_ORIGIN_KEY" >"$deploy/.secrets/posthog-origin.key"
fi
if [[ -n "${ANSIBLE_SECRETS_YML:-}" ]]; then
  printf '%s\n' "$ANSIBLE_SECRETS_YML" >"$deploy/ansible/secrets.yml"
fi

echo "Prepared the SSH route to $DEPLOY_SSH_HOST and the deploy files."
