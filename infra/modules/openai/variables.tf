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

variable "project_name" {
  description = "The Foundry project that holds evaluations."
  type        = string
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

variable "extract_model" {
  description = "A deployment for extraction alone; null to extract with the main one."
  type = object({
    name           = string
    version        = string
    capacity_k_tpm = number
  })
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
