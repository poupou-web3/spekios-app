# Publishing the demo

The demo is published at `https://demo-posthog.spekios.com` by the normal production release ([infra/deploy](../../infra/deploy/README.md)) when it is enabled. It runs in its own Compose project, `spekios-posthog-demo-site`, never joins the product's networks and mounts no certificates or product credentials. Only the HTTPS edge joins its network.

Files involved:

- `apps/posthog-demo/compose.public.yaml` removes the local port and names the network `spekios-posthog-demo-site_frontend`, with the alias `posthog-demo-site`.
- `compose.posthog-demo-edge.yaml` connects the edge to that network and mounts the demo route and certificate folder.
- `infra/edge/Caddyfile.posthog-demo` serves the hostname with the demo's own certificate, requires Cloudflare's Authenticated Origin Pulls client certificate and proxies to `posthog-demo-site:8086`.

## Enable it

1. **DNS** (not managed by Terraform). In Cloudflare → `spekios.com` → DNS → Records, add a proxied `A` record named `demo-posthog`, with the IPv4 address copied from the **Content** of the existing `app` record (not the proxy IP a public lookup returns).
2. **Certificate.** Create a Cloudflare Origin CA certificate for `demo-posthog.spekios.com` (**SSL/TLS → Origin Server → Create Certificate**). Save it as `infra/deploy/.secrets/posthog-origin.pem` and the key as `infra/deploy/.secrets/posthog-origin.key` (both gitignored). Keep the existing app certificates and AOP CA.
3. **Full (strict) TLS.** Set `posthog_demo_enabled = true` in `infra/deploy/terraform/terraform.tfvars` and run `just cloud-plan` and `just cloud-apply`. This only adds the hostname to the Full (strict) rule.
4. **Ansible settings.** Add these top-level entries to `infra/deploy/ansible/secrets.yml`:

   ```yaml
   scout_posthog_demo: true
   scout_posthog_demo_project_token: "phc_<dedicated-demo-public-capture-token>"
   ```

   To let Spekios replay recorded journeys against the demo, also set `SCOUT_POSTHOG_REPLAY_ORIGINS: https://demo-posthog.spekios.com` under `scout_env`.
5. **Release.** Run `just cloud-ci-setup` so GitHub Actions has the certificate pair (`POSTHOG_ORIGIN_PEM`, `POSTHOG_ORIGIN_KEY`) and the updated `secrets.yml`, then release from `main` as usual (or run `just cloud-deploy --tags app`).

On deploy, Ansible installs the certificate in `/etc/scout/posthog-demo`, writes `/opt/scout/shared/posthog-demo.env` with the public capture token and EU Cloud hosts, and sets `SCOUT_POSTHOG_DEMO_SITE`, `SCOUT_POSTHOG_DEMO_CERT_DIR` and `SCOUT_POSTHOG_DEMO_ENV_FILE` in the server's `.env`. `scripts/deploy.sh` then starts the demo project, validates the combined Caddy configuration and adds the edge overlay. It refuses to continue without the certificate and environment file.

The playbook does not check the demo's public URL. Confirm `https://demo-posthog.spekios.com/healthz` returns `{"status":"ok","service":"posthog-demo"}`. A Cloudflare 525/526 or TLS handshake error usually means the DNS record exists but the certificate or route is missing.

## Local verification

```sh
just posthog-edge-test   # bash scripts/test-posthog-edge.sh
```

This builds the demo image and checks HTTPS with a test certificate and an AOP client certificate, and that connections without the client certificate fail. Everything is disposable; no server, Cloudflare account or PostHog project is contacted.
