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

variable "github_workflow" {
  description = "Name of the workflow that may deploy, as in its name: field (.github/workflows/cd.yml)."
  type        = string
  default     = "CD"
}

# Whoever runs Terraform, CD included, these roles stay with the operator.
variable "operator_principal_id" {
  description = "Object ID of the person operating the deployment: Key Vault Secrets Officer, OpenAI user, config writer."
  type        = string
}

variable "app_package" {
  description = "Zip of the built Functions app to deploy. CD passes one per release; leave unset to keep the deployed code."
  type        = string
  default     = null
}

variable "register_resource_providers" {
  description = "Register the subscription's resource providers. CD turns it off: its rights stop at the resource group."
  type        = bool
  default     = true
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
