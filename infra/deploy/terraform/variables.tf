variable "admin_cidrs" {
  description = "Addresses allowed to reach SSH (port 22), e.g. [\"203.0.113.7/32\"]. Nothing else can open a shell."
  type        = list(string)

  validation {
    condition     = length(var.admin_cidrs) > 0 && alltrue([for c in var.admin_cidrs : can(cidrhost(c, 0))])
    error_message = "admin_cidrs must list at least one valid CIDR, such as \"203.0.113.7/32\"."
  }

  # 203.0.113.0/24 is the documentation range used in the example file.
  validation {
    condition     = !anytrue([for c in var.admin_cidrs : startswith(c, "203.0.113.")])
    error_message = "admin_cidrs still holds the example address. Put your own: curl -4 https://ifconfig.me, then \"<that IP>/32\"."
  }
}

variable "ssh_public_key_path" {
  description = "Public key installed for the deploy user. The private key is the same path without .pub; Ansible uses it."
  type        = string
  default     = "~/.ssh/spekios_hetzner.pub"

  validation {
    condition     = endswith(var.ssh_public_key_path, ".pub")
    error_message = "ssh_public_key_path must point to the .pub file."
  }
}

variable "server_name" {
  type    = string
  default = "scout-prod"
}

variable "server_type" {
  description = "Hetzner server type. Change it and apply to resize in place (the server reboots)."
  type        = string
  default     = "cx43"
}

variable "location" {
  description = "Hetzner location: nbg1, fsn1 or hel1 for CX plans."
  type        = string
  default     = "nbg1"
}

variable "image" {
  description = "Debian 13: its security archive carries the CVE-2026-98432 kernel fix (6.12.113-1, DSA-6568-1). Ansible refuses to deploy on a kernel it cannot verify."
  type        = string
  default     = "debian-13"
}

variable "server_backups" {
  description = "Hetzner daily server snapshots (7 kept, +20% of the server price)."
  type        = bool
  default     = true
}

variable "protect" {
  description = "Delete and rebuild protection on the server. Set false and apply before destroying it."
  type        = bool
  default     = true
}

variable "deploy_user" {
  description = "Login created by cloud-init. Root SSH login is disabled."
  type        = string
  default     = "deploy"
}

variable "cloudflare_zone" {
  type    = string
  default = "spekios.com"
}

variable "app_subdomain" {
  type    = string
  default = "app"
}

variable "backoffice_subdomain" {
  description = "Operator console hostname, protected by Cloudflare Access."
  type        = string
  default     = "bo"
}

variable "backoffice_allowed_emails" {
  description = "Who can pass Cloudflare Access to the operator console (one-time PIN sent by email). Empty means any email address; the console still requires the operator token either way."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.backoffice_allowed_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "backoffice_allowed_emails must contain email addresses."
  }

  validation {
    condition     = !anytrue([for e in var.backoffice_allowed_emails : endswith(lower(e), "@example.com")])
    error_message = "backoffice_allowed_emails still holds the example address. List the real people allowed on the back office."
  }
}

variable "manage_ssl_rule" {
  description = "Create a Configuration Rule that sets Full (strict) TLS for the app hostname only. Set false if the zone already has a Configuration Rules ruleset; then add the rule there by hand."
  type        = bool
  default     = true
}
