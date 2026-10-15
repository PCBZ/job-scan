variable "name" {
  description = "Storage account name: 3–24 lowercase letters and digits, globally unique."
  type        = string
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "containers" {
  description = "Private blob container names."
  type        = set(string)
}

variable "queues" {
  description = "Queue names."
  type        = set(string)
  default     = []
}

variable "tables" {
  description = "Table names."
  type        = set(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "expire_after_days" {
  description = "Containers whose blobs are deleted this many days after their last change."
  type        = map(number)
  default     = {}
}
