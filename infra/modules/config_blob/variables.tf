variable "container_id" {
  type = string
}

variable "content" {
  description = "config.toml's text."
  type        = string
  sensitive   = true
}

variable "writer_principal_ids" {
  description = "Who uploads the blob: every principal that runs Terraform."
  type        = map(string)
}
