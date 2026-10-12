# The app, built by CD from an empty resource group. infra/bootstrap creates the
# group, the Key Vault, the identities and every role assignment, so this
# stack holds none: CD's Contributor is enough.

# Storage accounts, OpenAI accounts and Function Apps need globally unique names.
resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  suffix = random_string.suffix.result
}

data "azurerm_resource_group" "main" {
  name = var.platform.resource_group_name
}
