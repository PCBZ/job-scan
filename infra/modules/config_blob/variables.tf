variable "container_id" {
  type = string
}

variable "source_path" {
  description = "Local path of the config.toml to upload."
  type        = string
}

variable "operator_principal_id" {
  description = "Object ID of whoever runs Terraform; it uploads the blob."
  type        = string
}
