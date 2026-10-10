variable "location" {
  description = "Azure region for every resource."
  type        = string
  default     = "canadacentral"
}

variable "name" {
  description = "Base name for resources. Globally unique names get a random suffix."
  type        = string
  default     = "job-scan"
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default = {
    project = "job-scan"
  }
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

variable "github_branch" {
  description = "Branch whose workflow runs may deploy."
  type        = string
  default     = "main"
}

variable "config_toml_path" {
  description = "config.toml to upload. Defaults to the one at the repository root (gitignored)."
  type        = string
  default     = null
}

# Names only, never values: set in terraform.tfvars (gitignored), from the keys
# config.toml reads (fetch_mail.py --env-template lists them).
variable "mail_credential_envs" {
  description = "App settings holding mailbox credentials, each resolved from the Key Vault secret named after it."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for k in var.mail_credential_envs : can(regex("^[A-Z][A-Z0-9_]*$", k))])
    error_message = "Each entry is an app setting name like GMAIL_MAIN_PASSWORD: uppercase letters, digits and _."
  }
}
