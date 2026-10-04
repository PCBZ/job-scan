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
