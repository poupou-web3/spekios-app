# Public demo deployment preparation

DNS points `demo-posthog.spekios.com` at the same origin as the app. DNS alone does not install its server certificate or configure the HTTPS virtual host; a missing route causes a Cloudflare TLS handshake failure.

The deployment includes these opt-in files, enabled only for hosts that publish the independent demo:

- `apps/posthog-demo/compose.public.yaml` removes the local published port and
  creates `spekios-posthog-demo-site_frontend` for the independent demo project.
- `compose.posthog-demo-edge.yaml` connects only the existing HTTPS edge to that
  network and mounts the demo route and dedicated certificate directory.
- `infra/edge/Caddyfile.posthog-demo` serves the exact hostname using the demo's
  own certificate, preserves the existing AOP client-certificate requirement and
  proxies to `posthog-demo-site:8086`.

Production must use a commit in `origin/main`, after the relevant changes have merged. Publishing a demo remains a separately configured deployment from instrumenting the product.

## Required deployment inputs

1. Create a dedicated Cloudflare Origin CA certificate for
   `demo-posthog.spekios.com`, via **SSL/TLS → Origin Server → Create Certificate**.
   Store the certificate and matching private key on the server as `origin.pem`
   and `origin.key` in a private directory, e.g.
   `/opt/scout/shared/posthog-demo-certs`. Give the key mode `0600`. Keep the
   existing app/operator certificates and AOP CA unchanged. The demo container
   never mounts any certificate or product credentials.
2. Keep the DNS record proxied and use **Full (strict)** for this hostname. If a
   hostname-specific TLS rule is managed by Terraform, include this hostname in
   its source configuration so later applies preserve it. Keep AOP enabled.
3. Prepare a separate demo environment file on the server with only the public
   ingestion token and the Cloud settings from `.env.example`. No `phx_` key or
   product `.env` belongs in the demo project.

## Repeatable app and demo releases

Set these top-level entries in ignored `ansible/secrets.yml`:

```yaml
scout_posthog_demo: true
scout_posthog_demo_project_token: "phc_<dedicated-demo-public-capture-token>"
```

Place the dedicated certificate and key in ignored `.secrets/posthog-origin.pem`
and `.secrets/posthog-origin.key`. Ansible installs them separately, writes the
independent demo environment file, and enables the extra edge overlay. The
regular main-based release starts the demo in its own Compose project, validates
Caddy before updating the edge, and preserves the existing Larchwood routes.
`cloud-ci-setup` saves the certificate pair and private configuration in GitHub
Actions secrets for subsequent releases. Enable `posthog_demo_enabled=true` in
Terraform's private variables so its strict TLS rule retains the demo hostname.

## Demo-only rollout sequence

After authorization and merging to main, start the separate project from that
verified main release, using its own environment file:

```sh
docker compose -p spekios-posthog-demo-site \
  --env-file /opt/scout/shared/posthog-demo.env \
  -f apps/posthog-demo/compose.yaml -f apps/posthog-demo/compose.public.yaml \
  up -d --build --wait demo
```

For the edge, retain **every overlay used by the active deployment**, including
the origin-TLS and existing Larchwood demo overlays. Append
`compose.posthog-demo-edge.yaml`, set `SCOUT_POSTHOG_DEMO_CERT_DIR` to the private
certificate directory and validate the combined Compose and Caddy configuration
before changing the edge. Then update only the edge using `--no-deps`; do not
rebuild or restart the app, API, databases or workers. Retain the extra edge
overlay in future deployments while the demo is published.

Verify `https://demo-posthog.spekios.com/healthz` identifies `posthog-demo`, open
the shop, and confirm the app/operator/existing demos still work. A matching
certificate alone is insufficient: the virtual host, AOP and upstream network
must also be configured. If edge validation fails, leave the running edge alone.

## Local verification

```sh
bash scripts/test-posthog-edge.sh
```

This builds the actual demo image and checks HTTPS with a matching test
certificate and an AOP client certificate. It also verifies that connections
without that client certificate fail. All containers, networks and certificate
fixtures are disposable; no real server, Cloudflare account or PostHog project
is contacted by the test.
