variable "name" {
  description = "Account name, also its subdomain. Globally unique."
  type        = string
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "model_name" {
  type = string
}

variable "model_version" {
  type = string
}

variable "capacity_k_tpm" {
  description = "Deployment capacity in thousands of tokens per minute. Draws on quota, not money."
  type        = number
}

variable "user_principal_ids" {
  description = "Principals granted Cognitive Services OpenAI User, keyed by a static label."
  type        = map(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
