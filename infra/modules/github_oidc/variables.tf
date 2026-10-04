variable "name" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "repository" {
  description = "GitHub repository as owner/name."
  type        = string
}

variable "branch" {
  description = "Branch whose workflow runs may deploy."
  type        = string
}

variable "function_app_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
