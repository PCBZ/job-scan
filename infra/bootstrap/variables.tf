variable "location" {
  type    = string
  default = "canadacentral"
}

variable "name" {
  description = "Base name, shared with the main stack."
  type        = string
  default     = "job-scan"
}

variable "tags" {
  type    = map(string)
  default = { project = "job-scan" }
}

# GitHub puts immutable owner and repository IDs in the OIDC subject
# (use_immutable_subject), so a renamed or re-created repository can't reuse
# the trust. Read the current prefix with:
#   gh api repos/PCBZ/job-scan/actions/oidc/customization/sub
variable "github_repository" {
  description = "Repository part of the OIDC subject, as owner@id/name@id."
  type        = string
  default     = "PCBZ@15225052/job-scan@1339064873"
}

variable "github_workflow" {
  description = "Name of the workflow that may deploy, as in its name: field (.github/workflows/cd.yml)."
  type        = string
  default     = "CD"
}

# Names only, never values: set in bootstrap/terraform.tfvars (gitignored), from
# the keys config.toml reads (fetch_mail.py --env-template lists them).
variable "mail_credential_envs" {
  description = "App settings holding mailbox credentials, each read from the Key Vault secret named after it."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for k in var.mail_credential_envs : can(regex("^[A-Z][A-Z0-9_]*$", k))])
    error_message = "Each entry is an app setting name like GMAIL_MAIN_PASSWORD: uppercase letters, digits and _."
  }
}
