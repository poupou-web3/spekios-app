# Hetzner VM + Cloudflare (proxied) for the Scout single-host deployment.
# Credentials come from the environment: HCLOUD_TOKEN and CLOUDFLARE_API_TOKEN.

provider "hcloud" {}
provider "cloudflare" {}

locals {
  fqdn        = "${var.app_subdomain}.${var.cloudflare_zone}"
  bo_fqdn     = "${var.backoffice_subdomain}.${var.cloudflare_zone}"
  ssh_fqdn    = "${var.ssh_subdomain}.${var.cloudflare_zone}"
  hostnames   = [local.fqdn, local.bo_fqdn]
  secrets_dir = "${path.module}/../.secrets"
  labels      = { app = "scout", managed_by = "terraform" }

  # The private half of ssh_public_key_path, for Ansible and the ssh outputs.
  ssh_private_key_path = trimsuffix(pathexpand(var.ssh_public_key_path), ".pub")

  # Exit 0 when a newer kernel is installed than the one running.
  newer_kernel_installed = "[ \"$(ls -1 /boot/vmlinuz-* | sed 's|^/boot/vmlinuz-||' | sort -V | tail -n 1)\" != \"$(uname -r)\" ]"
}

data "cloudflare_zone" "this" {
  filter = { name = var.cloudflare_zone }
}

# Cloudflare's published edge ranges. Only these may reach ports 80 and 443.
data "cloudflare_ip_ranges" "edge" {}

resource "hcloud_ssh_key" "deploy" {
  name       = "${var.server_name}-deploy"
  public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))
  labels     = local.labels
}

# The cloud firewall filters before traffic reaches the machine, so Docker's
# own iptables rules cannot open anything here. Outbound stays unrestricted:
# the browser sandboxes must reach the sites under test and the model APIs.
resource "hcloud_firewall" "scout" {
  name   = var.server_name
  labels = local.labels

  rule {
    description = "SSH from admin addresses"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.admin_cidrs
  }

  rule {
    description = "HTTPS from Cloudflare"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = concat(data.cloudflare_ip_ranges.edge.ipv4_cidrs, data.cloudflare_ip_ranges.edge.ipv6_cidrs)
  }

  rule {
    description = "HTTP from Cloudflare (Caddy redirects to HTTPS)"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = concat(data.cloudflare_ip_ranges.edge.ipv4_cidrs, data.cloudflare_ip_ranges.edge.ipv6_cidrs)
  }

  rule {
    description = "Ping from admin addresses"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = var.admin_cidrs
  }
}

resource "hcloud_server" "scout" {
  name         = var.server_name
  server_type  = var.server_type
  location     = var.location
  image        = var.image
  ssh_keys     = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.scout.id]
  backups      = var.server_backups
  labels       = local.labels

  # Keep the disk size on resize so the server can be scaled back down.
  keep_disk          = true
  delete_protection  = var.protect
  rebuild_protection = var.protect

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  user_data = "#cloud-config\n${yamlencode({
    users = [{
      name                = var.deploy_user
      groups              = ["sudo"]
      shell               = "/bin/bash"
      sudo                = "ALL=(ALL) NOPASSWD:ALL"
      lock_passwd         = true
      ssh_authorized_keys = [hcloud_ssh_key.deploy.public_key]
    }]
    disable_root = true
    ssh_pwauth   = false

    # Patch at first boot: the image's own kernel can predate security fixes
    # (Debian 13 images ship 6.12.107, vulnerable to CVE-2026-98432). Install
    # every update (cloud-init uses dist-upgrade, so new kernel packages come
    # in), then reboot into the newest kernel if it is not the one running.
    package_update  = true
    package_upgrade = true
    power_state = {
      mode      = "reboot"
      delay     = "now"
      message   = "Rebooting into the patched kernel"
      timeout   = 120
      condition = ["sh", "-c", local.newer_kernel_installed]
    }
  })}"

  lifecycle {
    # These only matter at creation; changing them must not replace the server and its data.
    ignore_changes = [image, ssh_keys, user_data]
  }
}

resource "cloudflare_dns_record" "app" {
  zone_id = data.cloudflare_zone.this.id
  name    = local.fqdn
  type    = "A"
  content = hcloud_server.scout.ipv4_address
  proxied = true
  ttl     = 1 # automatic; required for proxied records
  comment = "Scout workspace on Hetzner ${var.server_name}"
}

resource "cloudflare_dns_record" "backoffice" {
  zone_id = data.cloudflare_zone.this.id
  name    = local.bo_fqdn
  type    = "A"
  content = hcloud_server.scout.ipv4_address
  proxied = true
  ttl     = 1
  comment = "Scout operator console on Hetzner ${var.server_name} (Cloudflare Access)"
}

# ---- Origin TLS: a Cloudflare Origin certificate, trusted by Cloudflare only.

resource "tls_private_key" "origin" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem
  dns_names       = local.hostnames

  subject {
    common_name = local.fqdn
  }
}

resource "cloudflare_origin_ca_certificate" "origin" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = local.hostnames
  request_type       = "origin-ecc"
  requested_validity = 5475
}

# Full (strict) for these hostnames only, leaving the rest of the zone untouched.
resource "cloudflare_ruleset" "origin_tls" {
  count       = var.manage_ssl_rule ? 1 : 0
  zone_id     = data.cloudflare_zone.this.id
  name        = "Scout origin TLS"
  description = "Validate the Cloudflare Origin certificate on the Scout hostnames"
  kind        = "zone"
  phase       = "http_config_settings"

  rules = [{
    ref               = "scout_app_tls_strict"
    description       = "Full (strict) TLS to the Scout origin"
    expression        = "(http.host in {${join(" ", [for h in local.hostnames : "\"${h}\""])}})"
    action            = "set_config"
    action_parameters = { ssl = "strict" }
    enabled           = true
  }]
}

# ---- Authenticated Origin Pulls with our own CA.
# Cloudflare presents this client certificate on every connection to the
# origin for this zone, and Caddy rejects connections without it. Cloudflare's
# shared AOP certificate would also be presented for other customers' zones;
# a private CA means only spekios.com traffic can reach the server, so nobody
# can route around Cloudflare Access by pointing their own zone at this IP.
resource "tls_private_key" "aop_ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "aop_ca" {
  private_key_pem       = tls_private_key.aop_ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 24 * 365 * 10
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    common_name  = "Scout origin pull CA"
    organization = var.cloudflare_zone
  }
}

resource "tls_private_key" "aop_client" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "aop_client" {
  private_key_pem = tls_private_key.aop_client.private_key_pem

  subject {
    common_name = "Cloudflare origin pull for ${var.cloudflare_zone}"
  }
}

resource "tls_locally_signed_cert" "aop_client" {
  cert_request_pem      = tls_cert_request.aop_client.cert_request_pem
  ca_private_key_pem    = tls_private_key.aop_ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.aop_ca.cert_pem
  validity_period_hours = 24 * 365 * 5
  allowed_uses          = ["digital_signature", "key_encipherment", "client_auth"]
}

resource "cloudflare_authenticated_origin_pulls_certificate" "zone" {
  zone_id     = data.cloudflare_zone.this.id
  certificate = tls_locally_signed_cert.aop_client.cert_pem
  private_key = tls_private_key.aop_client.private_key_pem
}

# Zone-wide: other origins in the zone (such as the Lovable site) simply ignore
# a client certificate they did not ask for.
resource "cloudflare_authenticated_origin_pulls_settings" "zone" {
  zone_id = data.cloudflare_zone.this.id
  enabled = true

  depends_on = [cloudflare_authenticated_origin_pulls_certificate.zone]
}

# ---- Cloudflare Access in front of the operator console.

resource "cloudflare_zero_trust_access_policy" "backoffice" {
  account_id       = data.cloudflare_zone.this.account.id
  name             = "Scout operators"
  decision         = "allow"
  session_duration = "12h"
  # No listed emails: anyone who receives the one-time PIN passes Access. The
  # operator token is then the only real gate, as it is on app.spekios.com.
  include = length(var.backoffice_allowed_emails) == 0 ? [{ everyone = {} }] : [
    for e in var.backoffice_allowed_emails : { email = { email = e } }
  ]
}

resource "cloudflare_zero_trust_access_application" "backoffice" {
  account_id           = data.cloudflare_zone.this.account.id
  name                 = "Scout back office"
  type                 = "self_hosted"
  domain               = local.bo_fqdn
  session_duration     = "12h"
  app_launcher_visible = false

  policies = [{
    id         = cloudflare_zero_trust_access_policy.backoffice.id
    precedence = 1
  }]
}

# ---- SSH for GitHub Actions through a Cloudflare Tunnel.
# Port 22 stays limited to admin_cidrs. cloudflared on the server dials out to
# Cloudflare and forwards ssh.<zone> to its own sshd. Only the deploy service
# token passes Access, and the CI key it carries is accepted only from
# localhost (tasks/tunnel.yml), so neither secret works without the other.

resource "cloudflare_zero_trust_tunnel_cloudflared" "ssh" {
  account_id = data.cloudflare_zone.this.account.id
  name       = "${var.server_name}-ssh"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "ssh" {
  account_id = data.cloudflare_zone.this.account.id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.ssh.id

  config = {
    ingress = [
      { hostname = local.ssh_fqdn, service = "ssh://localhost:22" },
      { service = "http_status:404" },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "ssh" {
  account_id = data.cloudflare_zone.this.account.id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.ssh.id
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = data.cloudflare_zone.this.id
  name    = local.ssh_fqdn
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.ssh.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "SSH to ${var.server_name} for GitHub deploys (Cloudflare Tunnel + Access)"
}

# Does not expire: an expiring token would silently stop deploys. Rotate with
# `tofu apply -replace=cloudflare_zero_trust_access_service_token.deploy`,
# then `just cloud-ci-setup`.
resource "cloudflare_zero_trust_access_service_token" "deploy" {
  account_id = data.cloudflare_zone.this.account.id
  name       = "${var.server_name} GitHub deploy"
  duration   = "forever"
}

resource "cloudflare_zero_trust_access_policy" "deploy_ssh" {
  account_id = data.cloudflare_zone.this.account.id
  name       = "Scout GitHub deploy"
  decision   = "non_identity"
  include = [{
    service_token = { token_id = cloudflare_zero_trust_access_service_token.deploy.id }
  }]
}

resource "cloudflare_zero_trust_access_application" "deploy_ssh" {
  account_id           = data.cloudflare_zone.this.account.id
  name                 = "Scout deploy SSH"
  type                 = "self_hosted"
  domain               = local.ssh_fqdn
  session_duration     = "1h"
  app_launcher_visible = false

  policies = [{
    id         = cloudflare_zero_trust_access_policy.deploy_ssh.id
    precedence = 1
  }]
}

# ---- Files Ansible reads. All of them are gitignored.

resource "local_file" "origin_cert" {
  filename             = "${local.secrets_dir}/origin.pem"
  content              = cloudflare_origin_ca_certificate.origin.certificate
  file_permission      = "0600"
  directory_permission = "0700"
}

resource "local_sensitive_file" "origin_key" {
  filename             = "${local.secrets_dir}/origin.key"
  content              = tls_private_key.origin.private_key_pem
  file_permission      = "0600"
  directory_permission = "0700"
}

resource "local_file" "aop_ca" {
  filename             = "${local.secrets_dir}/aop-ca.pem"
  content              = tls_self_signed_cert.aop_ca.cert_pem
  file_permission      = "0600"
  directory_permission = "0700"
}

resource "local_sensitive_file" "tunnel_token" {
  filename             = "${local.secrets_dir}/tunnel-token"
  content              = data.cloudflare_zero_trust_tunnel_cloudflared_token.ssh.token
  file_permission      = "0600"
  directory_permission = "0700"
}

resource "local_file" "inventory" {
  filename        = "${path.module}/../ansible/inventory.yml"
  file_permission = "0644"
  content = yamlencode({
    scout = {
      hosts = {
        (var.server_name) = {
          ansible_host                 = hcloud_server.scout.ipv4_address
          ansible_user                 = var.deploy_user
          ansible_ssh_private_key_file = local.ssh_private_key_path
          scout_public_host            = local.fqdn
          scout_backoffice_host        = local.bo_fqdn
        }
      }
    }
  })
}
