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
