variable "name" {
  description = "Key Vault name: 3–24 characters, globally unique."
  type        = string
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "tenant_id" {
  type = string
}

variable "secrets_officer_principal_id" {
  description = "Object ID granted Key Vault Secrets Officer."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
