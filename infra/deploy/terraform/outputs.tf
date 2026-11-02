output "server_ipv4" {
  value = hcloud_server.scout.ipv4_address
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
