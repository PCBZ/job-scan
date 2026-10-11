variable "location" {
  type    = string
  default = "canadacentral"
}

# From the main stack after its first apply: terraform -chdir=.. output deployer.
# Null until then; the CD identity's rights are granted here, outside what a
# CD run applies, so it can't widen them.
variable "deployer" {
  description = "The CD identity's principal ID and the resource group it manages."
  type = object({
    principal_id        = string
    resource_group_name = string
  })
  default = null
}
