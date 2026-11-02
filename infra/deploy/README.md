# Production host: Hetzner + Cloudflare

This folder deploys the single-machine stack from [deployment](../../docs/platform/deployment.md) onto one Hetzner Cloud **CX43** (8 vCPU, 16 GB, **Debian 13**). Two hostnames go through a **proxied** Cloudflare zone:

- **https://app.spekios.com** serves the customer workspace and API.
- **https://bo.spekios.com** serves the operator console. Cloudflare Access sits in front of it, so only listed email addresses get through, and the console still asks for the operator token.

Two tools do the work:

- **Terraform** (OpenTofu works the same way) creates the server, its firewall, both DNS records, the Cloudflare Origin certificate, the Full (strict) TLS rule, the Authenticated Origin Pulls client certificate, and the Access application.
- **Ansible** hardens the host, patches the kernel and checks it, installs Docker, ships a committed revision of the code, and runs `scripts/deploy.sh edge`.

```
Internet ─▶ Cloudflare ── TLS + our client cert ─▶ Hetzner firewall ─▶ Caddy ─▶ api:8080         (app)
            (Access on bo)                         443/80 from              └──▶ backoffice:8080  (bo)
                                                   Cloudflare only;
                                                   22 from admin_cidrs
```

## Getting started from zero

You run everything below from this repository on your own machine. The only accounts you need are Hetzner and the Cloudflare account that already holds `spekios.com`.

1. **Install the tools on your machine** (macOS: `brew install opentofu ansible`). The `ansible` package includes the `community.general` and `ansible.posix` collections this needs.
2. **Create a Hetzner account** at https://accounts.hetzner.com/signUp. Hetzner verifies new accounts, sometimes asking for ID or a small prepayment, so do this first.
3. **Create a Hetzner Cloud project:** open https://console.hetzner.cloud, create a project such as "Spekios", then go to *Security → API tokens* and create a **Read & Write** token.
4. **Turn on Cloudflare Zero Trust** (needed once for Access): in the Cloudflare dashboard, open *Zero Trust*, choose a team name, and select the **Free** plan (free for up to 50 users). The one-time PIN login method is enabled by default.
5. **Create a Cloudflare API token** under *My Profile → API Tokens → Create custom token*:
   - Zone permissions, limited to `spekios.com`:
     - Zone → Read
     - DNS → Edit
     - SSL and Certificates → Edit (Origin certificate, Authenticated Origin Pulls)
     - Config Rules → Edit (Full (strict) for the two hostnames)
   - Account permission:
     - Access: Apps and Policies → Edit
6. **Create a dedicated SSH key** for this server: `ssh-keygen -t ed25519 -f ~/.ssh/spekios_hetzner -C spekios-hetzner`. A passphrase is recommended; macOS can keep it in the Keychain with `ssh-add --apple-use-keychain ~/.ssh/spekios_hetzner`. Terraform installs the public half, and Ansible and the `ssh` output use the private half. To use another key, set `ssh_public_key_path`.
7. **Fill in your variables:**
   ```sh
   cp infra/deploy/terraform/terraform.tfvars.example infra/deploy/terraform/terraform.tfvars
   # edit it:
   #   admin_cidrs               = your IP (curl -4 https://ifconfig.me) + "/32"
   #   backoffice_allowed_emails = the people allowed on bo.spekios.com ([] = any email)
   cp infra/deploy/ansible/secrets.example.yml infra/deploy/ansible/secrets.yml   # model provider keys, optional
   export HCLOUD_TOKEN=...  CLOUDFLARE_API_TOKEN=...
   ```
8. **Deploy** from the repository root:
   ```sh
   just cloud-check    # read-only: both tokens work, every permission is there, the image exists
   just cloud-plan     # review what will be created
   just cloud-apply    # creates the server, firewall, DNS, certificates and Access app; writes ansible/inventory.yml and .secrets/
   just cloud-deploy   # host setup, kernel check, first deploy (the API compiles on the server: about 15–20 min)
   ```

To ship new code after that, commit it and run `just cloud-deploy --tags app`, or `just cloud-deploy -e scout_ref=<branch|tag|sha>`. Only committed code is deployed: the playbook uses `git archive` and never sends your working tree.

## What is reachable

| Port | From | Why |
|---|---|---|
| 443 | Cloudflare's IP ranges only | Caddy, and only with our client certificate |
| 80 | Cloudflare's IP ranges only | Caddy redirects to HTTPS |
| 22 | `admin_cidrs` (may be everyone: `["0.0.0.0/0", "::/0"]`) | SSH as `deploy` with a key only; root login and passwords are off. Debian 13's OpenSSH slows down repeated failed attempts from the same address. Opened to everyone, this is the only port reachable without going through Cloudflare. |
| anything else | nobody | Postgres, ClickHouse, the bucket and the internal ports bind to 127.0.0.1 |

The layers, from the outside in:

1. **The Hetzner cloud firewall** filters traffic before it reaches the machine. That matters because Docker-published ports bypass `ufw`. `ufw` still runs on the host as a second layer for sshd.
2. **Authenticated Origin Pulls with a private CA.** Caddy only completes a TLS handshake if the client presents the certificate Terraform uploaded to the `spekios.com` zone. That shuts out direct hits on the IP. It also stops someone pointing their own Cloudflare zone at this IP to get past Access: Cloudflare's shared origin-pull certificate would let any zone through, a private CA does not.
3. **The Cloudflare Origin certificate:** only Cloudflare trusts it, and Full (strict) is set for these two hostnames only. The rest of the zone, including the Lovable site, is unchanged.
4. **Strict SNI/Host matching:** a request can't name one hostname in TLS and the other in HTTP.
5. **Cloudflare Access on `bo`:** an email one-time PIN, then the operator token. `backoffice_allowed_emails = []` lets any email through, leaving the operator token as the real gate, the same token that already works on the API through `app`. The deploy fails if an anonymous request to `bo` isn't redirected to the Access login.

Inside the host:

- Containers can't reach `169.254.0.0/16`, which covers the Hetzner metadata service. Every deploy checks this from inside `browser-sandbox`.
- Chromium's own sandbox stays on. Its container uses [seccomp-chromium.json](../recorder/seccomp-chromium.json), which is Docker's default profile with namespace creation allowed. If the host's kernel blocks unprivileged user namespaces (Ubuntu 24.04 does by default, Debian does not), Ansible allows them. The browser sandboxes only pass their health check if Chromium actually started with its sandbox, so a deploy where it can't start fails.

## Kernel vulnerabilities (CVE-2026-98432)

[CVE-2026-98432](https://security-tracker.debian.org/tracker/CVE-2026-98432) is a use-after-free in the IPv4 TCP handshake. It's remote and needs no login (CVSS 9.8), and is triggered by IP options in a SYN. The published exploit path needs a multipath TCP (MPTCP) listener. Go programs such as Caddy open those by default. This deployment handles it in five ways:

- **A patched OS.** Debian 13's security archive has the fix (`linux 6.12.113-1`, DSA-6568-1). Ubuntu 24.04 is still marked vulnerable ([tracker](https://ubuntu.com/security/CVE-2026-98432)), so the default image is `debian-13`.
- **Patched at first boot.** The Debian image itself ships a vulnerable kernel (`6.12.107-1`). cloud-init, set up by Terraform, installs every update (`dist-upgrade`) on first boot and reboots into the new kernel before anything else runs. Until then, only your SSH addresses can reach the server.
- **A proven kernel.** The first thing Ansible does is boot the newest installed kernel, install anything published since, and boot again if needed. It then **refuses to configure or deploy anything** unless the running kernel's package is at least the version recorded in `scout_kernel_minimum` ([group_vars/scout.yml](ansible/group_vars/scout.yml)). A distribution without a recorded entry, such as Ubuntu today, is refused too.
- **Staying patched.** Unattended upgrades install security updates daily and reboot at 04:30 (server time) when a kernel needs it. Containers restart on their own.
- **Interim protections that don't depend on the patch.** `net.mptcp.enabled=0` turns off MPTCP, and an nftables rule drops inbound IPv4 TCP packets that carry IP options. That's the Red Hat and AlmaLinux mitigation, and ordinary traffic never sets them.
- **Little exposure in the first place.** Only Cloudflare reaches 80 and 443. Cloudflare ends the client's TCP connection and opens its own to the origin, so a client's crafted SYN never reaches this kernel. SSH is limited to your addresses.

When a new kernel CVE matters, check the Debian tracker and raise `scout_kernel_minimum`. The next `just cloud-deploy` then refuses to continue until the server runs a fixed kernel.

## Day to day

```sh
ssh deploy@<ip>                         # `tofu -chdir=infra/deploy/terraform output ssh`
cd /opt/scout/current && export COMPOSE_FILE=compose.yaml:compose.deploy.yaml:compose.edge-origin.yaml
docker compose ps                       # status
docker compose logs -f api
grep SCOUT_API_TOKEN /opt/scout/shared/.env   # the operator token for bo.spekios.com
```

Each release goes to `/opt/scout/releases/<sha>`, with `/opt/scout/current` pointing at the latest. The three most recent are kept. Data lives in the named Compose volumes of project `scout-qa`, so switching releases never touches it. `/opt/scout/shared/.env` is generated on the server the first time and never replaced. Ansible only updates the keys it manages and the ones in `secrets.yml`.

- **Your IP changed:** update `admin_cidrs` and run `just cloud-apply`. The firewall changes in place.
- **Someone else needs the back office:** give them the operator token. If `backoffice_allowed_emails` lists addresses, also add theirs and run `just cloud-apply`.
- **Bigger server:** set `server_type = "cx53"` (16 vCPU, 32 GB) and run `just cloud-apply`. Hetzner powers off, resizes and boots, which takes a few minutes; the IP and data are kept. The disk keeps its size (`keep_disk`), so you can scale back down. Raise `SCOUT_BROWSER_SLOTS` in `secrets.yml` to use the extra capacity.
- **Moving to a new server:** apply with a new `server_name`, deploy, then move the data. The DNS records are proxied, so the switch is immediate.
- **Destroying:** set `protect = false`, apply, then run `tofu destroy`. Server backups (`server_backups`, 7 daily snapshots) are deleted along with the server.
- **Fallback to the back office if Access is down:** `ssh -N -L 18083:127.0.0.1:18083 deploy@<ip>`, then open http://127.0.0.1:18083.

## Spekios sign-in on app.spekios.com

The local `spekios-local` client only allows `http://localhost:18080/auth/callback`. For production:

1. Register a second Lovable client whose redirect URI is exactly `https://app.spekios.com/auth/callback`. See [SPEKIOS_AUTH.md](../../SPEKIOS_AUTH.md).
2. Put the five `SPEKIOS_*` values in `secrets.yml`.
3. Run `just cloud-deploy --tags app`.

Until then, the workspace asks for the API token.

## Files that stay private (all gitignored)

- `terraform/terraform.tfstate`: holds the Origin key and the origin-pull keys
- `terraform/terraform.tfvars`
- `.secrets/`: Origin certificate and key, origin-pull CA
- `ansible/inventory.yml`
- `ansible/secrets.yml`
- `.build/`: release archives

Keep the state file somewhere safe. If more than one person deploys, the next step is a private remote backend, for example Hetzner Object Storage through the `s3` backend.

## Troubleshooting

- **"No verified fixed kernel is recorded" or "older than":** the server isn't on a kernel known to be fixed. Run `just cloud-deploy --tags kernel` after the distribution publishes a fix. Only record a new minimum after checking the vendor's tracker.
- **The playbook fails on "Confirm the public URL":** the stack is up but Cloudflare didn't return 200. Check that Bot Fight Mode or the WAF isn't challenging the request, and that the Full (strict) rule exists. If `manage_ssl_rule = false`, add it under *Rules → Configuration Rules*.
- **Cloudflare returns 526 or 525:** the origin rejected the TLS connection. Check that `.secrets/aop-ca.pem` is on the server in `/etc/scout/edge`, and that *SSL/TLS → Origin Server → Authenticated Origin Pulls* is on for the zone.
- **`terraform apply` fails on the Access application:** Zero Trust isn't set up for the account yet (step 4), or the token lacks *Access: Apps and Policies → Edit*.
- **`terraform apply` fails on the ruleset:** the zone already has a Configuration Rules ruleset. Set `manage_ssl_rule = false` and add the rule (hostname in `app.spekios.com`, `bo.spekios.com`; SSL set to Full (strict)) in the dashboard.
- **SSH host-key warning after recreating the server:** Hetzner reuses IPs. Run `ssh-keygen -R <ip>`.
