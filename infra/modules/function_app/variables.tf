variable "name" {
  description = "Function App name, globally unique. The plan derives from it."
  type        = string
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "node_version" {
  description = "Node runtime. 24 is the newest Flex Consumption offers."
  type        = string
  default     = "24"
}

variable "instance_memory_in_mb" {
  type    = number
  default = 512
}

variable "maximum_instance_count" {
  type    = number
  default = 1
}

variable "storage_account_name" {
  type = string
}

variable "deployment_container_endpoint" {
  description = "Blob container URL that holds the deployment package."
  type        = string
}

variable "identity_id" {
  description = "Resource ID of the app's user-assigned identity."
  type        = string
}

variable "identity_client_id" {
  description = "Client ID of that identity, for host storage and DefaultAzureCredential."
  type        = string
}

variable "application_insights_connection_string" {
  type      = string
  sensitive = true
}

variable "app_settings" {
  type    = map(string)
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
