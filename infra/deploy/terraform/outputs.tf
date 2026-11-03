output "server_ipv4" {
  value = hcloud_server.scout.ipv4_address
}

output "demo_fixed_url" {
  value = var.demo_sites_enabled ? "https://${local.demo_hosts.fixed}" : ""
}

output "demo_faulty_url" {
  value = var.demo_sites_enabled ? "https://${local.demo_hosts.faulty}" : ""
}

output "server_ipv6" {
  value = hcloud_server.scout.ipv6_address
}

output "public_url" {
  value = "https://${local.fqdn}"
}

output "backoffice_url" {
  description = "Operator console behind Cloudflare Access; it then asks for the operator token."
  value       = "https://${local.bo_fqdn}"
}

output "ssh" {
  value = "ssh -i ${local.ssh_private_key_path} ${var.deploy_user}@${hcloud_server.scout.ipv4_address}"
}

output "operator_console_tunnel" {
  description = "Fallback if Cloudflare Access is unavailable: run this, then open http://127.0.0.1:18083."
  value       = "ssh -i ${local.ssh_private_key_path} -N -L 18083:127.0.0.1:18083 ${var.deploy_user}@${hcloud_server.scout.ipv4_address}"
}

# Read by `just cloud-ci-setup`, which stores them as GitHub Actions secrets.
output "deploy_ssh_host" {
  description = "SSH hostname for GitHub deploys, reached through the Cloudflare Tunnel."
  value       = local.ssh_fqdn
}

output "deploy_access_client_id" {
  value     = cloudflare_zero_trust_access_service_token.deploy.client_id
  sensitive = true
}

output "deploy_access_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.deploy.client_secret
  sensitive = true
}
