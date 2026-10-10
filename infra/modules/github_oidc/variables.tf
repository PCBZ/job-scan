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
  description = "Repository part of the OIDC subject: owner@id/name@id when the repository uses immutable subjects, else owner/name."
  type        = string
}

variable "subject_claims" {
  description = "The claims after repo in the OIDC subject, in the order of the repository's include_claim_keys."
  type        = list(object({ key = string, value = string }))
}

variable "function_app_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
