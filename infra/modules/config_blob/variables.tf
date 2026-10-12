variable "container_id" {
  type = string
}

variable "content" {
  description = "config.toml's text."
  type        = string
  sensitive   = true
}
