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

variable "app_version" {
  description = "The release being deployed; CD passes the tag."
  type        = string
  default     = "local"
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default = {
    project = "job-scan"
  }
}

# infra/bootstrap's output: CD gets it as TF_VAR_platform, a local apply from
#   terraform -chdir=bootstrap output -json main_tfvars > platform.auto.tfvars.json
variable "platform" {
  description = "What bootstrap built for the app: its resource group, Key Vault, identity and secret settings."
  type = object({
    resource_group_name = string
    key_vault_id        = string
    key_vault_uri       = string
    app_identity_id     = string
    app_client_id       = string
    secret_settings     = list(string)
    # The judge's answers (#150). Optional, so a release before bootstrap has
    # been applied again runs without the cache instead of failing the plan.
    cosmos_endpoint  = optional(string)
    cosmos_database  = optional(string)
    cosmos_container = optional(string)
  })
}
